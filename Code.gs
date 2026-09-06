/**
 * ==============================================================================
 * 🤖 個人財務助理 LINE Bot + Google Sheets + 儀表板 API (Code.gs)
 * ==============================================================================
 * 
 * 核心功能：
 * 1. 【doPost】LINE Bot 接收自然語言記帳 -> Gemini 極速解析 -> 寫入「記帳明細」與更新「月度彙總」
 * 2. 【doGet】提供 Cloudflare Pages 前端儀表板透過 HTTP GET 讀取所有帳目資料
 * 3. 【快取去重】使用 CacheService 防止 LINE 伺服器重試導致重複記帳
 * 4. 【日期修復】以原生 Date 物件寫入試算表，呈現「yyyy/M/d 上午/下午 hh:mm:ss」真日期（靠右對齊）
 * 5. 【月份靠右】最右側「月份」欄位強制設定為靠右對齊
 * 6. 【乾淨回覆】LINE 回覆格式恢復為最習慣的簡潔 4 行版
 * 7. 【Gemini 備援鏈】依序嘗試 gemini-3.1-flash-lite -> 3.5-flash-lite -> 2.5-flash-lite，秒回
 * ==============================================================================
 */

// ==============================================================================
// 1. 核心參數設定區（可直接填入引號中，或在 GAS「專案設定」->「指令碼屬性」中設定）
// ==============================================================================
const CONFIG = {
  // LINE Messaging API Channel access token
  LINE_CHANNEL_ACCESS_TOKEN: getSecret('LINE_CHANNEL_ACCESS_TOKEN', '請填入你的LINE_TOKEN'),

  // Google AI Studio Gemini API Key
  GEMINI_API_KEY: getSecret('GEMINI_API_KEY', '請填入你的GEMINI_API_KEY'),

  // Google 試算表 ID（若此指令碼已綁定在試算表內部，可留空）
  SPREADSHEET_ID: getSecret('SPREADSHEET_ID', ''),

  // 前端儀表板存取密鑰 Token（需與網頁設定一致）
  API_SECRET_TOKEN: getSecret('API_SECRET_TOKEN', '')
};

// 極速模型備援鏈（官方 API 端點嚴格要求全小寫連字號）
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',  // 500 RPD 額度最高、極速主力
  'gemini-3.5-flash-lite',  // 500 RPD 額度最高、備援
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash'
];

// 標準五大分類白名單（絕無「生存」）
const VALID_CATEGORIES = ['生活', '家用', '社交', '娛樂', '雜支'];

/**
 * 取得設定值（優先讀取「指令碼屬性」，若無則使用預設值）
 */
function getSecret(key, defaultValue = '') {
  try {
    const prop = PropertiesService.getScriptProperties().getProperty(key);
    if (prop && prop.trim()) {
      return prop.trim();
    }
  } catch (e) {}
  return (defaultValue || '').trim();
}

/**
 * 取得試算表實例
 */
function getSpreadsheet() {
  if (CONFIG.SPREADSHEET_ID && !CONFIG.SPREADSHEET_ID.startsWith('YOUR_') && !CONFIG.SPREADSHEET_ID.startsWith('請填入')) {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

// ==============================================================================
// 2. LINE Webhook 接收與處理核心 (doPost)
// ==============================================================================
function doPost(e) {
  if (!e || !e.postData) {
    return ContentService.createTextOutput("錯誤：請勿在 GAS 編輯器直接點擊執行 doPost。");
  }

  try {
    const postData = JSON.parse(e.postData.contents);
    const events = postData.events;

    if (!events || events.length === 0) {
      return ContentService.createTextOutput("OK");
    }

    const cache = CacheService.getScriptCache();

    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') {
        continue;
      }

      const userText = (event.message.text || '').trim();
      const replyToken = event.replyToken;
      const eventId = event.webhookEventId || replyToken;

      // 【去重機制】1 分鐘內防重複處理
      const cacheKey = 'line_evt_' + eventId;
      if (cache.get(cacheKey)) {
        Logger.log(`⚠️ 忽略重複事件: ${eventId}`);
        continue;
      }
      cache.put(cacheKey, 'processed', 60);

      // 若使用者傳送 ping 測試
      if (userText.toLowerCase() === 'ping') {
        replyToLine(replyToken, 'pong 🏓 系統連線正常！');
        continue;
      }

      try {
        // 1. 呼叫 Gemini AI 解析記帳內容
        const parsedData = callGemini(userText);

        // 2. 寫入 Google 試算表（原生真日期 + 月份靠右對齊 + 同步月度彙總）
        writeToSheet(parsedData.item, parsedData.category, parsedData.amount);

        // 3. 回覆習慣的簡潔 4 行格式
        const replyMessage = `✅ 記帳成功\n項目：${parsedData.item}\n金額：${parsedData.amount}\n分類：${parsedData.category}`;

        replyToLine(replyToken, replyMessage);

      } catch (err) {
        Logger.log(`❌ 處理使用者記帳失敗: ${err.message}`);
        const helpMessage = `❓ 無法辨識消費內容。\n請嘗試輸入範例：「午餐排骨便當 120」\n(除錯訊息: ${err.message})`;
        replyToLine(replyToken, helpMessage);
      }
    }

    return ContentService.createTextOutput("OK");

  } catch (globalError) {
    Logger.log(`❌ doPost 異常: ${globalError.message}`);
    return ContentService.createTextOutput("ERROR: " + globalError.message);
  }
}

// ==============================================================================
// 3. Gemini API 呼叫核心（極速備援鏈 + 徹底杜絕冗餘後綴）
// ==============================================================================
function callGemini(userText) {
  const apiKey = CONFIG.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith('YOUR_') || apiKey.startsWith('請填入')) {
    throw new Error('未設定 GEMINI_API_KEY，請填入有效金鑰');
  }

  const now = new Date();
  const todayStr = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd');

  const systemPrompt = `你是一個專業個人記帳助理。請從使用者的自然語言訊息中，精準擷取「項目名稱」、「分類類別」與「消費金額」。
今天是：${todayStr}。

【五大標準分類規則（必須且僅能從中擇一）】
1. 「生活」：正餐、午餐、便當、超商、全家、7-11、早餐、飲料、食材買菜、水電瓦斯日常必要
2. 「家用」：房租、家具、日用耗材、修繕裝潢、家電
3. 「社交」：聚餐、請客、送禮、紅白包、朋友分帳
4. 「娛樂」：電影、遊戲課金、Netflix/Spotify訂閱、旅遊玩樂、非必要休閒
5. 「雜支」：看醫生診所掛號費、藥品、捷運悠遊卡交通、無法歸類之臨時支出

【項目名稱原則（極為重要！）】
- 保持使用者輸入的原貌精髓，例如「全家」、「排骨便當」、「看醫生」。
- 絕對禁止自行添加「消費」、「支出」、「花費」、「購買」等贅字（例如使用者輸入「全家 500」，項目必須是「全家」，不得為「全家消費」）。

【回傳格式】
嚴格只回傳乾淨的 JSON，嚴格禁止任何 Markdown 語法或額外文字說明：
{"item": "項目名稱", "category": "生活|家用|社交|娛樂|雜支", "amount": 數字}`;

  const payload = {
    contents: [
      {
        parts: [
          { text: systemPrompt },
          { text: `使用者輸入：「${userText}」` }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: {
        thinkingBudget: 0 // 關閉思考模式以獲得 1 秒極速秒回
      },
      temperature: 0.1
    }
  };

  let lastErrorDetail = '';

  // 遍歷備援模型鏈
  for (const rawModelName of GEMINI_MODELS) {
    const modelId = rawModelName.trim().toLowerCase().replace(/\s+/g, '-');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const statusCode = response.getResponseCode();
      const responseText = response.getContentText();

      if (statusCode === 200) {
        const resJson = JSON.parse(responseText);
        const rawContent = resJson.candidates?.[0]?.content?.parts?.[0]?.text;

        if (rawContent) {
          const cleanedText = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(cleanedText);

          if (parsed && parsed.item && parsed.amount != null) {
            let cat = String(parsed.category || '生活').trim();
            if (cat === '生存' || !VALID_CATEGORIES.includes(cat)) {
              cat = '生活';
            }

            // 清理項目贅字
            let cleanItem = String(parsed.item).trim()
              .replace(/(消費|花費|支出|購買)$/, '')
              .trim();
            if (!cleanItem) cleanItem = String(parsed.item).trim();

            const result = {
              item: cleanItem,
              category: cat,
              amount: Math.abs(Number(parsed.amount)) || 0
            };

            Logger.log(`✅ [${modelId}] 解析成功: ${JSON.stringify(result)}`);
            return result;
          }
        }
      } else {
        Logger.log(`⚠️ 模型 [${modelId}] 回應 HTTP ${statusCode}: ${responseText.slice(0, 180)}`);
        lastErrorDetail = `[${modelId}] HTTP ${statusCode}`;
      }
    } catch (e) {
      Logger.log(`⚠️ 模型 [${modelId}] 請求異常: ${e.message}`);
      lastErrorDetail = `[${modelId}] ${e.message}`;
    }
  }

  throw new Error(`所有備援模型皆無回應 (${lastErrorDetail || '請確認 API Key 與額度'})`);
}

// ==============================================================================
// 4. Google 試算表寫入核心（原生 Date 物件 + 月份靠右對齊）
// ==============================================================================
function writeToSheet(item, category, amount) {
  const ss = getSpreadsheet();
  
  // 1. 取得「記帳明細」工作表
  const detailSheet = ss.getSheetByName('記帳明細') || ss.getSheets()[0];

  const now = new Date(); // 原生 JavaScript Date 物件
  const monthStr = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM');

  // 寫入原生 Date 物件 now，Google 試算表視為真日期時間（自動靠右對齊）
  detailSheet.appendRow([now, item, category, Number(amount), monthStr]);

  const lastRow = detailSheet.getLastRow();

  // 1. A 欄（時間）：設定格式為「yyyy/M/d 上午/下午 hh:mm:ss」（自動靠右對齊）
  detailSheet.getRange(lastRow, 1).setNumberFormat("yyyy/M/d am/pm h:mm:ss");

  // 2. D 欄（金額）：設定千分位數字格式（自動靠右對齊）
  detailSheet.getRange(lastRow, 4).setNumberFormat("#,##0");

  // 3. E 欄（月份）：設定純文字並「強制靠右對齊」
  detailSheet.getRange(lastRow, 5).setNumberFormat("@").setHorizontalAlignment("right");

  // 4. 同步累加至「月度彙總」工作表
  try {
    syncMonthlySummary(ss, monthStr, Number(amount));
  } catch (summaryErr) {
    Logger.log('⚠️ 同步月度彙總警示: ' + summaryErr.message);
  }

  return {
    month: monthStr
  };
}

/**
 * 同步累加更新「月度彙總」工作表
 */
function syncMonthlySummary(ss, monthStr, amount) {
  const summarySheet = ss.getSheetByName('月度彙總');
  if (!summarySheet) return;

  const data = summarySheet.getDataRange().getValues();
  let found = false;

  for (let i = 1; i < data.length; i++) {
    const rowMonth = String(data[i][0]).trim();
    if (rowMonth === monthStr || rowMonth.startsWith(monthStr)) {
      const currentVal = Number(data[i][1]) || 0;
      summarySheet.getRange(i + 1, 2).setValue(currentVal + amount);
      summarySheet.getRange(i + 1, 2).setNumberFormat("#,##0");
      found = true;
      break;
    }
  }

  if (!found) {
    summarySheet.appendRow([monthStr, amount]);
    const newRow = summarySheet.getLastRow();
    summarySheet.getRange(newRow, 1).setNumberFormat("@").setHorizontalAlignment("right");
    summarySheet.getRange(newRow, 2).setNumberFormat("#,##0");
  }
}

// ==============================================================================
// 5. LINE 訊息回覆模組
// ==============================================================================
function replyToLine(replyToken, messageText) {
  const token = CONFIG.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || token.startsWith('YOUR_') || token.startsWith('請填入')) {
    Logger.log('⚠️ 未設定 LINE_CHANNEL_ACCESS_TOKEN，跳過 LINE 回覆');
    return;
  }

  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    replyToken: replyToken,
    messages: [
      {
        type: 'text',
        text: messageText
      }
    ]
  };

  try {
    UrlFetchApp.fetch(url, {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Authorization': 'Bearer ' + token
      },
      method: 'post',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('❌ LINE 回覆訊息失敗: ' + e.message);
  }
}

// ==============================================================================
// 6. 前端儀表板 API 介面 (doGet)
// ==============================================================================
function doGet(e) {
  try {
    if (CONFIG.API_SECRET_TOKEN && !CONFIG.API_SECRET_TOKEN.startsWith('YOUR_') && !CONFIG.API_SECRET_TOKEN.startsWith('請填入')) {
      const incomingToken = e && e.parameter ? (e.parameter.token || '').trim() : '';
      if (incomingToken !== CONFIG.API_SECRET_TOKEN) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error',
          message: '403 Forbidden: 驗證密鑰錯誤，存取遭拒。'
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    const ss = getSpreadsheet();

    // 1. 讀取「記帳明細」
    const detailSheet = ss.getSheetByName('記帳明細') || ss.getSheets()[0];
    const details = detailSheet ? detailSheet.getDataRange().getDisplayValues() : [];

    // 2. 讀取「月度彙總」
    const summarySheet = ss.getSheetByName('月度彙總');
    const summary = summarySheet ? summarySheet.getDataRange().getDisplayValues() : [];

    const result = {
      status: 'success',
      details: details,
      summary: summary,
      updatedAt: Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX")
    };

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: '讀取試算表資料失敗: ' + error.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==============================================================================
// 7. 編輯器一鍵測試工具
// ==============================================================================
function testGeminiApi() {
  Logger.log('=== 開始測試 Gemini API 解析能力 ===');
  const testInputs = ['便當 350', '全家 250'];

  for (const input of testInputs) {
    try {
      const res = callGemini(input);
      Logger.log(`輸入: 「${input}」 ➜ 解析: 項目=[${res.item}], 分類=[${res.category}], 金額=[${res.amount}]`);
    } catch (err) {
      Logger.log(`❌ 測試「${input}」失敗: ${err.message}`);
    }
  }
}

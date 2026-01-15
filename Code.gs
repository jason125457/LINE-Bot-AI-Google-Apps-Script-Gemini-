/**
 * 核心邏輯：LINE Bot 接收文字 -> Gemini 解析 -> 寫入 Google Sheet
 * 修復重點：
 * 1. 加入 CacheService 防止 LINE 重送導致的重複記帳
 * 2. 修正模型名稱為 gemini-2.5-flash 
 * 3. 精簡欄位：只保留 [時間, 項目, 類別, 金額, 月份]
 */

// ==========================================
// 1. 設定參數
// ==========================================
const LINE_CHANNEL_ACCESS_TOKEN = 'LINE_CHANNEL_ACCESS_TOKEN';
const GEMINI_API_KEY = 'GEMINI_API_KEY';
const SPREADSHEET_ID = 'SPREADSHEET_ID';

// 設定模型名稱 (建議改用 2.5-flash，速度快且穩定)
const MODEL_NAME = 'gemini-2.5-flash'; 

// ==========================================
// 核心邏輯區
// ==========================================
function doPost(e) {
  // 基本檢查：避免直接在編輯器按執行
  if (!e || !e.postData) {
    return ContentService.createTextOutput("錯誤：請勿在 GAS 編輯器直接執行 doPost。");
  }

  try {
    const msg = JSON.parse(e.postData.contents);
    
    // LINE Verify 事件 (Webhook 驗證用)
    if (!msg.events || msg.events.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({status: 'ok', msg: 'verified'})).setMimeType(ContentService.MimeType.JSON);
    }

    // 取得 GAS 的快取服務 (這是防止重複記帳的關鍵)
    var cache = CacheService.getScriptCache();

    // 處理每一個事件
    for (var i = 0; i < msg.events.length; i++) {
      const event = msg.events[i];
      const replyToken = event.replyToken;
      const eventId = event.webhookEventId; // LINE 每個訊息的身分證

      // 1. 過濾無效 Token
      if (!replyToken || replyToken === '00000000000000000000000000000000') {
        continue;
      }

      // 2. [關鍵修正] 去重檢查 (Idempotency Check)
      // 如果這個 eventId 已經在快取中，代表是 LINE 重送的，直接略過
      if (cache.get(eventId)) {
        console.log("⚠️ 攔截到重複請求 (Retry)，已跳過執行: " + eventId);
        continue; 
      }
      
      // 3. 立即上鎖 (鎖定 600 秒)
      cache.put(eventId, "processed", 600);

      // 4. 執行主邏輯
      processEvent(event);
    }

    // 回傳成功訊號給 LINE
    return ContentService.createTextOutput(JSON.stringify({status: 'success'})).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    console.error("System Error: " + error.toString());
    return ContentService.createTextOutput(JSON.stringify({status: 'error', message: error.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * 處理單一事件
 */
function processEvent(event) {
  const replyToken = event.replyToken;
  const userMessage = event.message ? event.message.text : "";
  const userId = event.source ? event.source.userId : "";

  // 只處理文字訊息
  if (!userMessage) return;

  // A. 呼叫 Gemini 解析訊息
  const expenseData = parseWithGemini(userMessage);

  // B. 處理 Gemini 回傳結果
  let replyText = "";
  
  if (expenseData.status === "success") {
    // 呼叫寫入函式 (已移除 userId 參數依賴，因為不需要寫入它了)
    writeToSheet(expenseData);
    replyText = `✅ 記帳成功！\n項目：${expenseData.item}\n金額：${expenseData.amount}\n分類：${expenseData.category}`;
  } else {
    // 失敗時回傳原始錯誤以便 Debug，或者提示使用者格式
    replyText = `❓ 無法識別記帳資訊。\n請嘗試類似：「午餐排骨飯 120」\n(Debug: ${expenseData.raw})`;
  }

  // C. 回覆 LINE
  replyToLine(replyToken, replyText);
}

/**
 * 呼叫 Gemini API 進行語意分析
 */
function parseWithGemini(text) {
  if (!text) return { status: "failed", raw: "無輸入文字" };

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
    你是一個記帳助手。請分析使用者的輸入： "${text}"。
    請擷取以下資訊並輸出為嚴格的 JSON 格式 (不要 Markdown code block)：
    {
      "item": "消費項目 (字串)",
      "amount": "金額 (數字, 移除幣別符號)",
      "category": "類別 (例如: 餐飲, 交通, 購物, 娛樂, 居家, 醫療, 其他)",
      "status": "若成功擷取回傳 'success', 失敗回傳 'failed'"
    }
    如果無法判斷金額或項目，status 請回傳 'failed'。
    現在只要輸出 JSON 字串即可，不要解釋。
  `;

  const payload = {
    "contents": [{
      "parts": [{
        "text": prompt
      }]
    }]
  };

  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(apiUrl, options);
    const json = JSON.parse(response.getContentText());
    
    if (json.error) {
       console.error("Gemini API Error: " + JSON.stringify(json));
       return { status: "failed", raw: `API Error ${json.error.code}: ${json.error.message}` };
    }
    
    if (!json.candidates || !json.candidates[0] || !json.candidates[0].content) {
       return { status: "failed", raw: "Gemini 回傳結構異常" };
    }

    const aiResponseText = json.candidates[0].content.parts[0].text;
    const cleanJson = aiResponseText.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleanJson);

  } catch (e) {
    console.error("Gemini API Exception: " + e.toString());
    return { status: "failed", raw: "程式執行錯誤: " + e.toString() };
  }
}

/**
 * 寫入 Google Sheet
 * 修改：只保留 [時間, 項目, 類別, 金額, 月份]
 */
function writeToSheet(data) {
  if (!data) return;

  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('記帳明細');
  
  if (!sheet) {
    // 自動防呆：如果找不到分頁，就不要報錯，可以選擇 Log 或自動建立
    console.error("❌ 找不到工作表 '記帳明細'");
    return;
  }

  const date = new Date();
  const monthStr = Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM");
  
  // 按照你的要求：只保留 時間、項目、類別、金額、月份
  sheet.appendRow([
    date,           // 時間
    data.item,      // 項目
    data.category,  // 類別
    data.amount,    // 金額
    monthStr        // 月份
  ]);
}

/**
 * 回覆 LINE 訊息
 */
function replyToLine(replyToken, text) {
  if (!replyToken || !text) return;

  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }]
  };
  
  try {
    UrlFetchApp.fetch(url, {
      'headers': {
        'Content-Type': 'application/json; charset=UTF-8',
        'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN,
      },
      'method': 'post',
      'payload': JSON.stringify(payload),
    });
  } catch (e) {
    console.error("LINE API Error: " + e.toString());
  }
}

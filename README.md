# LINE-Bot-AI-Google-Apps-Script-Gemini
這是一個基於 Google Apps Script (GAS) 的 Serverless 記帳機器人。使用者只需透過 LINE 傳送文字（例如：「午餐吃排骨飯 120元」），系統即會呼叫 Google Gemini AI 進行語意分析，自動提取「項目、金額、類別」，並將資料寫入 Google Sheets。

🚀 核心功能

自然語言記帳：不需要輸入特定指令，支援自然語句分析。

AI 語意解析：使用 Google Gemini 模型  (2.5 Flash)自動分類消費類別。

防重複寫入機制 (Idempotency)：利用 CacheService 實作冪等性檢查，解決 LINE Webhook 重試機制導致的重複記帳問題。

自動化報表：支援 Google Sheets QUERY 語法自動生成月度統計。

🛠️ 技術棧

Runtime: Google Apps Script (GAS)

Messaging API: LINE Messaging API

AI Model: Google Gemini API ( gemini-2.5-flash)

Database: Google Sheets

⚙️ 安裝步驟

1. 準備工作

申請 LINE Developers 帳號，建立 Channel 並取得 Channel Access Token。

申請 Google AI Studio API Key。

建立一個新的 Google Sheet。

2. 設定 Google Sheets

在試算表中建立三個分頁 (Sheet)，命名如下：

記帳明細 (用於儲存原始資料)

分類統計 (用於報表)

月度匯總 (用於報表)

3. 部署程式碼

開啟 Google Sheet，點選 擴充功能 > Apps Script。

將本專案的 Code.gs 內容複製貼上。

修改變數：將程式碼最上方的 LINE_CHANNEL_ACCESS_TOKEN、GEMINI_API_KEY、SPREADSHEET_ID 替換為你的真實資料。

點選 部署 > 新增部署 > 類型選擇 網頁應用程式。

執行身分：我 (Me)

存取權：任何人 (Anyone)

複製生成的 網頁應用程式 URL。

4. 設定 LINE Webhook

回到 LINE Developers Console，將剛剛複製的 URL 貼入 Webhook URL 欄位並啟用。

建議開啟 Use webhook。

建議關閉 Auto-response messages (自動回應)。

建議關閉 Webhook redelivery (雖然程式碼已有防護，但關閉可減少無效請求)。

📊 報表公式設定

請在對應分頁的 A1 儲存格貼上以下公式：

分類統計 (依月份與類別)

=QUERY('記帳明細'!A:E, "SELECT E, C, SUM(D) WHERE A IS NOT NULL GROUP BY E, C ORDER BY E DESC LABEL E '月份', C '類別', SUM(D) '總金額'", 1)


月度匯總 (僅依月份)

=QUERY('記帳明細'!A:E, "SELECT E, SUM(D) WHERE A IS NOT NULL GROUP BY E ORDER BY E DESC LABEL E '月份', SUM(D) '總支出'", 1)


⚠️ 注意事項

模型版本：程式碼預設使用 gemini-2.5-flash。若該模型尚未對你的 API Key 開放，請將程式碼中的 MODEL_NAME 改回 gemini-1.5-flash。

配額限制：Gemini API 免費版有每分鐘請求限制 (RPM)，個人記帳通常不會觸發，但請勿用於高併發場景。

安全性：請勿將含有真實 Key 的 Code.gs 直接公開分享。

# 部署收集用的 Cloudflare Worker

> 已於 2026-08-21 部署完成，網址 `https://zipa-review-api.zipapoker2025.workers.dev`，
> `wrangler.toml` 裡的 `database_id` 也已填好。以下步驟保留給重建或換帳號時使用；
> 日常只會用到最後兩節（看資料、清空）。
>
> 憑證放在 `~/.config/cloudflare/zipa.env`（權限 600，不在任何 repo 裡），
> 每次操作前先 `source ~/.config/cloudflare/zipa.env`。

頁面本身是靜態的，GitHub Pages 只負責送出檔案。同事按下的「同意／有疑慮／先保留」
需要一個地方存放，這個資料夾就是那個地方：一個 Cloudflare Worker 加一個 D1 資料庫，
免費方案綽綽有餘（九個節次、十幾位同事，一輩子都用不完額度）。

全部只做一次，大約五分鐘。

## 1. 登入

```bash
cd worker
npx wrangler login
```

## 2. 建資料庫

```bash
npx wrangler d1 create zipa-review
```

指令會印出一段 `database_id = "…"`，把它貼進 `wrangler.toml` 取代
`PASTE_DATABASE_ID_HERE`，然後建表：

```bash
npx wrangler d1 execute zipa-review --remote --file=./schema.sql
```

## 3. 設定通行碼

這組通行碼同事要用來進入審閱頁，也是彙總頁的鑰匙。取一組好念、不好猜的短句。

```bash
npx wrangler secret put REVIEW_CODE
```

## 4. 上線

```bash
npx wrangler deploy
```

最後會印出網址，形如 `https://zipa-review-api.zipapoker2025.workers.dev`。

## 5. 接到頁面上

回到 repo 根目錄，把那個網址填進 `review-config.js`：

```js
window.ZP_REVIEW_API = "https://zipa-review-api.zipapoker2025.workers.dev";
```

commit 並 push，GitHub Pages 重新部署後就可以把連結與通行碼發給同事。

## 檢查是否活著

```bash
curl https://zipa-review-api.zipapoker2025.workers.dev/health
# {"ok":true}
```

## 之後想看資料

- 網頁：審閱頁右下角的「彙總」，或直接開 `results.html`。
- CSV：`https://…workers.dev/results.csv?code=你的通行碼`
- 指令：`npx wrangler d1 execute zipa-review --remote --command "SELECT * FROM votes"`

## 會後清空（下一輪審閱再用）

```bash
npx wrangler d1 execute zipa-review --remote --command "DELETE FROM votes"
```

## 安全邊界

`ALLOWED_ORIGIN` 限定只有審閱頁那個網域可以從瀏覽器呼叫，`REVIEW_CODE` 擋掉沒有通行碼的人。
這足以應付一場內部審閱，但不是身分驗證：知道通行碼的人可以用任何姓名送出回覆。
真正機密的內容不要放在這頁上。

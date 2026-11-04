# ぼくのかんがえたサイキョウ・ロワイヤル

| フォルダ | 中身 | Cloudflare の Worker |
| --- | --- | --- |
| `site/` | ゲーム本体（`public/index.html`） | saikyo-royale |
| `kantei/` | キャラ鑑定サーバー（`worker.js`） | saikyo-kantei |

このリポジトリに変更が入ると、Cloudflare が自動でデプロイします。
OpenAI の API キーはこのリポジトリには置かず、Cloudflare の「変数とシークレット」にだけ登録しています。

最終更新：Cloudflare の自動デプロイを設定

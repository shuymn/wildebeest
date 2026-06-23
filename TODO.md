# TODO

Wildebeest（Mastodon 互換 Fediverse サーバー / Cloudflare）の作業管理。**2026-06-08 時点**の状態を反映。

> Phase 番号（1.1〜7）の定義と migration 方針の正典は **`docs/data-model-migration.md`**。本ファイルは状態とタスクの追跡に徹し、詳細はそこへリンクする。

## 現状

| 項目 | 状態 |
|------|------|
| ブランチ | `feat/social-interactions-api` |
| データモデル設計 | ドキュメント **コミット済み**（PR #721） |
| Mastodon 参照 | `github.com/mastodon/mastodon` @ `v4.5.11`（下記「参照」） |
| API ドキュメント参照 | `mastodon/documentation` @ `960eeb05` |
| 実装 | Phase 1–2 migration SQL・Lists API・基本ソーシャル操作 API 実装済み |
| migration 後方互換方針 | **Stance A 確定**（2026-06-08）。正典 → `docs/data-model-migration.md` の "Backward-Compatibility Stance: A" |

### PR #724 の変更内容（`feat/phase1-2-migrations`、merged）

- `migrations/0024`–`0035` — Phase 1–2 migration SQL
- `schema.sql`, `scripts/migration.sh`, `scripts/check-schema.sh`
- Lists API — `packages/backend/src/mastodon/list.ts`, `routes/api/v1/lists*`, `timelines/list/`, `types/list.ts`
- `interaction_count` — `packages/backend/src/mastodon/interaction_count.ts` + follow / like / reblog 連携

---

## Migration 方針（Stance A・要約）

> **正典・全文 → `docs/data-model-migration.md` の "Backward-Compatibility Stance: A"**（決定・経緯・代替案・5ルール・version-floor 却下理由）。ここは作業時のクイック参照。

- **Stance A** = 数分の 500 / 一時的機能停止は許容、**データ消失・破損は不可**。
- **複数の独立運用者が fork を deploy**（sync で保留中の全 migration を一気適用 → コード）。jump を手動で防げないので、安全性は **migration ファイル自体に内在させる（all-at-once-safe）**。下流は sync 一発で「数分の 500 → 復帰・損失なし」、手作業不要。義務はメンテナ側へ。
- **守る 5 ルール**: ①全 backfill は純・冪等 SQL ②非 SQL ステップを後続ファイル（特に DROP）の前提にしない ③JS 変換は migration に入れない（lazy on-read／劣化どまり） ④全 DROP に CHECK ガード（未完ならデプロイ失敗） ⑤チェーンは append-only（squash/削除しない）。
- **未対処の致命リスク**（タスク化済み、詳細は doc）:
  - ~~🔴 `interaction_count=0` purge → **Phase 1.7 backfill**~~ → **backfill SQL 完了**（`0029`）。cleanup 有効化前に運用コード（bookmark 残）も必要
  - `id_sequences` 衝突 / 二重カウント / FTS5 索引欠落 → ルール 1・3・Phase 7 ガードで対処

---

## 完了済み

- [x] Mastodon API 互換の目標スキーマ設計（約 55 テーブル）
- [x] TypeScript 型設計（Row / Domain / API レイヤー）
- [x] 7 フェーズ migration 計画
- [x] D1 ストレージ戦略・cleanup worker 仕様
- [x] reblog を `statuses.reblog_of_id` に統一（`reblogs` テーブル廃止）
- [x] `actor_replies` / `actor_reblogs` 移行ガイダンス（Phase 3.11, 3.13, 4, 7）
- [x] retention カラムの migration 追加（Phase 1.6: `cached_at`, `expires_at`, `interaction_count`）
- [x] cleanup spec の前提条件・非目標の明確化
- [x] Wildebeest を `origin/main` に更新
- [x] Mastodon 参照リポジトリを v4.5.3 → v4.5.11 に更新
- [x] `mastodon/documentation` を最新化（960eeb05）
- [x] `docs/mastodon-api-spec` の GitHub リンクを v4.5.11 に更新
- [x] `STATUS.md` / `endpoint-inventory.md` に Collections / Profile エンドポイント追加
- [x] ドキュメントをコミット（PR #721: STATUS.md, `docs/`, Stance A, mastodon-api-spec v4.5.11）
- [x] Phase 1–2 の migration SQL 生成（`0024`–`0035`、Stance A 5 ルール準拠）
- [x] Phase 1.6 retention カラム backfill SQL（`0028_backfill_retention_columns.sql`）
- [x] Phase 1.7 `interaction_count` backfill SQL（`0029_backfill_interaction_count.sql`）
- [x] `interaction_count` 運用コード（follow / favourite / reblog — `interaction_count.ts`）
- [x] Lists API 基盤（CRUD、`/lists/:id/accounts`、list タイムライン、テスト）
- [x] `packages/backend/src/types/list.ts` 型定義
- [x] `scripts/check-schema.sh` — migration 適用後の schema 整合性検証
- [x] PR #724 merged
- [x] Basic social interaction APIs: bookmark / unbookmark / GET bookmarks
- [x] Basic social interaction APIs: unfavourite / GET favourites
- [x] Basic social interaction APIs: unreblog
- [x] Basic social interaction APIs: block / unblock / mute / unmute / GET blocks / GET mutes
- [x] `relationships` の blocking / blocked_by / muting 反映
- [x] `interaction_count` 運用コード（bookmark / unbookmark / unfavourite / unreblog 減算）
- [x] Phase 4 read queries: replies/reblogs count と reply lookup を新カラムへ移行
- [x] `packages/backend/src/types/bookmark.ts`, `block.ts`, `mute.ts` 型定義

---

## TODO（優先順）

### 1. Phase 1–2 の変更をコミット・PR ✅

PR #724 で merged 済み。

```bash
pnpm run database:create-mock
pnpm test
./scripts/check-schema.sh
```

### 2. 残 API 実装

`STATUS.md` の Priority 列を参照。

| 優先 | 対象 | 理由 |
|------|------|------|
| 🟡 | follow requests / scheduled statuses / conversations / domain blocks 等 | 残る基本 API |
| 🟢 | 登録 / 検索 / markers | 新規ユーザー体験 |
| — | Collections / Profile `[v4.6+]` | Mastodon v4.6 参照まで後回し可 |

### 3. 既存コードの query 移行（Phase 4）

`actor_replies` / `actor_reblogs` 依存を解消する。

| ファイル | 内容 |
|----------|------|
| `packages/backend/src/mastodon/timeline.ts` | `actor_replies` 依存 |
| `packages/backend/src/mastodon/reply.ts` | `actor_replies` 依存 |
| `packages/backend/src/activitypub/objects/index.ts` | `actor_reblogs` / `actor_replies` 削除処理 |

`actor_replies` 依存の read query と replies/reblogs count は新カラムへ移行済み。`actor_reblogs` の reblog 表示・dual-write は後続の `feat/phase4-reblog-dual-write` で対応する。

### 4. `interaction_count` の残操作 ✅

bookmark / unbookmark / unfavourite / unreblog の増減まで実装済み。

### 5. spec の追記（実装前）

`docs/mastodon-api-spec/client-api/core-endpoints.md` に Collections / Profile の詳細を追加。  
`STATUS.md` と `endpoint-inventory.md` には既に載せ済み。

### 6. TypeScript 型ファイル生成

`docs/data-model-types.md` を `packages/backend/src/types/` に反映（`list.ts` / `bookmark.ts` / `block.ts` / `mute.ts` は完了）。

### 7. cleanup worker 実装（低優先度）

`docs/cleanup-worker-spec.md` に従う。Phase 1.6 + 1.7 backfill + `interaction_count` 管理コード完了後に有効化。

---

## 設計上の決定（参照用）

| 決定 | 理由 |
|------|------|
| 単一 D1 + retention ポリシー | 個人/小規模向け。sharding / 外部 DB は見送り |
| reblog = status 行（`reblog_of_id`） | Mastodon 準拠、カウントずれ防止 |
| テーブル改名（Phase 6）は任意 | SQLite FK 再作成が複雑。API 層で抽象化可能 |
| リモート status 削除時は local の fav/bookmark も削除 | 対象なしの interaction は意味がない |
| notifications は TTL で削除 | Mastodon と同様の ephemeral データ |
| migration 後方互換 = Stance A | 停止は許容／消失は不可。安全性は migration ファイルに内在（順序＋CHECK ガード＋lazy）。正典 → `docs/data-model-migration.md` |

---

## 参照（再現可能な形）

実装の参照元。**ローカルの clone パスは各自の環境依存**（環境変数等で任意）なので、ここでは upstream と pin だけを記録する。

| 参照 | upstream | Pin |
|------|----------|-----|
| Mastodon サーバー実装 | `github.com/mastodon/mastodon` | tag `v4.5.11` |
| Mastodon API ドキュメント | `github.com/mastodon/documentation`（mastodon の submodule） | commit `960eeb05` |

```bash
# 参照元を手元に用意する例（パスは任意）
git clone https://github.com/mastodon/mastodon && (cd mastodon && git checkout v4.5.11 && git submodule update --init)
```

---

## 重要ファイル

| ファイル | 用途 |
|----------|------|
| `schema.sql` | 現行スキーマ（migration の起点） |
| `docs/data-model-design.md` | 目標スキーマ（実装の source of truth） |
| `docs/data-model-migration.md` | 7 フェーズ migration 計画 |
| `docs/data-model-types.md` | TypeScript 型定義 |
| `docs/storage-strategy.md` | D1 容量戦略 |
| `docs/cleanup-worker-spec.md` | cleanup worker 仕様 |
| `docs/mastodon-api-spec/` | Wildebeest 向け API 仕様 |
| `STATUS.md` | エンドポイント実装状況マトリクス |

---

## 注意点

- **migration の順序**: 純 SQL backfill（DROP より前の番号）→ CHECK ガード → DROP（Phase 7）。下流の一気適用でも順に走る（all-at-once-safe）
- **冪等性**: 全 backfill は再実行安全に（`WHERE <new> IS NULL` / `INSERT OR IGNORE`）。D1 無トランザクション＝再実行が既定
- **denormalized count**: `interaction_count`, `replies_count` 等は操作と原子的に更新する
- **cleanup worker**: Phase 1.6 + **1.7 backfill** + `interaction_count` 管理コードがないと有効化不可（無効のまま enable すると remote 投稿をサイレント消去）
- **docs/updating.md**: ✅ 訂正済み（「How updates are applied」「Updating after falling behind」「squash 禁止」を追記。旧「non-destructive」誤記は撤去）
- **v4.6+ API**: Collections / Profile は documentation にあるが、参照中の Mastodon コード（v4.5.11）には未実装

---

## 未決事項

- Phase 6（`actors` → `accounts` 改名）をいつ実行するか、常に API 抽象化で済ませるか
- `interaction_count` の許容ドリフト量
- cleanup worker の実行頻度（daily 以外が必要か）
- Mastodon 参照を v4.6 以降に上げるタイミング（Collections / Profile 実装時）
- ~~最小サポート元バージョンを README に明記~~ → `docs/updating.md` に「遅れていても sync 一発で安全・損失なし／チェーンを squash しない」を記載済み（最小元バージョン強制はルール1〜3 を守れば原則不要）

> ✅ 解決済み: migration 後方互換方針 → **Stance A**（停止は許容／消失は不可）。詳細は上記「Migration 方針」。

---

## 開発コマンド

```bash
pnpm install
pnpm run database:create-mock
pnpm test
pnpm run dev
pnpm run lint
```

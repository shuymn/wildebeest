// Trends (migration 0057_trends), as Mastodon 4.5 works them out (app/models/trends/{tags,statuses}.rb): the hashtags
// and statuses that trend, scored every 5 minutes by the cron's round (jobs/scheduled.ts trendsRound) from what the
// Store holds, listed by GET /api/v1/trends/tags and /statuses (mastodon/trends.ts), and reviewed by the Access admin
// (app/admin.ts /admin/trends, `kopje-admin trends`). The only module that reads or writes trend_tags, trend_statuses,
// tag_trend_reviews, status_trend_reviews and account_trend_reviews (test-node/policy-boundary.test.ts).
//
// R41 (docs/visibility.md): a listed status passes trendableStatusSql (audience.ts) and, for a signed-in viewer, the
// list rule (R8); hashtags count public originals of available accounts only (VIS-12). Deviations: MD-5
// (docs/mastodon-deviations.md).

// SUPPORTED_LOCALES of Mastodon's LanguagesHelper (app/helpers/languages_helper.rb:4-226): ISO_639_1 (184 keys),
// ISO_639_1_REGIONAL (4) and ISO_639_3 (22), the languages a status may trend in (valid_locale?). Not the list of
// GET /api/v1/instance/languages, nor the Accept-Language preference.
export const TREND_LANGUAGES: ReadonlySet<string> = new Set([
	...'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo'.split(
		' '
	),
	...'es et eu fa ff fi fj fo fr fy ga gd gl gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki'.split(
		' '
	),
	...'kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mn-Mong mr ms ms-Arab mt my na nb'.split(
		' '
	),
	...'nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sn so sq sr ss st'.split(
		' '
	),
	...'su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' '),
	...'zh-CN zh-HK zh-TW zh-YUE'.split(' '),
	...'ast chr ckb cnr csb gsw jbo kab ldn lfn moh nds pdc sco sma smj szl tok vai xal zba zgh'.split(' '),
])

// The parameter value trendableStatusSql's `langs` takes.
export const TREND_LANGUAGES_JSON = JSON.stringify([...TREND_LANGUAGES])

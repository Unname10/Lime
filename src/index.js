const FEEDS = [
	'https://vnexpress.net/rss/kinh-doanh.rss',
	'https://vnexpress.net/rss/doi-song.rss',
	'https://vietstock.vn/144/chung-khoan.rss',
	'https://vietstock.vn/579/nhan-dinh-phan-tich.rss',
	'https://cafef.vn/thi-truong-chung-khoan.rss',
	'https://bnews.vn/rss/chung-khoan-33.rss',
	// Thêm RSS CafeF, Vietstock... (mở URL trên trình duyệt để chắc chắn còn sống)
];

function getVietnameseDateTime() {
	const formatter = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Asia/Ho_Chi_Minh',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});

	const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((p) => [p.type, p.value]));

	return {
		date: `${parts.day}/${parts.month}/${parts.year} \n`,
		time: `${parts.hour}:${parts.minute}:${parts.second} \n`,
		full: `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} \n`,
	};
}

async function timedFetch(label, url, opts = {}, ms = 15000) {
	const t = Date.now();
	console.log(`${label}: start`);
	try {
		const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
		console.log(`${label}: ${res.status} in ${Date.now() - t}ms`);
		return res;
	} catch (e) {
		console.error(`${label} FAILED after ${Date.now() - t}ms:`, e.name, e.message);
		throw e;
	}
}

const clean = (s) =>
	s
		.replace(/<!\[CDATA\[|\]\]>/g, '')
		.replace(/&amp;/g, '&')
		.trim();

function parseItems(xml, limit = 10) {
	const items = [];
	const re = /<item>([\s\S]*?)<\/item>/g;
	let m;
	while (items.length < limit && (m = re.exec(xml))) {
		const title = /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1];
		const link = /<link>([\s\S]*?)<\/link>/.exec(m[1])?.[1];
		if (title && link) items.push({ title: clean(title), link: clean(link) });
	}
	return items;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLUECHIPS = 'VCB, BID, CTG, TCB, VPB, MBB, ACB, HPG, FPT, VNM, VIC, VHM, MWG, GAS, MSN, SSI, GVR, SAB, PLX';
const LIFE =
	/giá xăng|xăng dầu|giá vàng|vàng miếng|tỷ giá|giá điện|lãi suất (tiết kiệm|vay|huy động)|lạm phát|CPI|giá heo|giá thịt|giá gạo|giá cà phê|giá nhà|giá đất|bất động sản|lương tối thiểu|bảo hiểm|thuế/i;

const isMarket = (t) => KEYWORDS.test(t) || TICKERS.test(t);
const isLife = (t) => LIFE.test(t.normalize('NFC'));
const HOT_CRON = '0 2-8 * * 1-5';

// Từ khóa tin nóng, bạn tự tinh chỉnh theo thực tế
const KEYWORDS =
	/VN-?Index|HNX-?Index|tăng trần|giảm sàn|bán ròng|mua ròng|khối ngoại|margin|tỷ giá|NHNN|UBCK|đình chỉ|hạn chế giao dịch|xử phạt|cổ tức|chào bán|thoái vốn|room ngoại|ETF/i;
const TICKERS = new RegExp(`\\b(${BLUECHIPS.split(', ').join('|')})\\b`); // phân biệt hoa thường

async function collect(env, seenKey) {
	const seen = new Set(seenKey ? JSON.parse((await env.STATE.get(seenKey)) || '[]') : []);
	const results = await Promise.allSettled(
		FEEDS.map((u) =>
			timedFetch('feed ' + new URL(u).host + new URL(u).pathname, u, {
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stock-news-bot)' },
			}).then((r) => r.text()),
		),
	);
	const all = results.filter((r) => r.status === 'fulfilled').flatMap((r) => parseItems(r.value));
	const uniq = new Map();
	for (const i of all) if (!seen.has(i.link) && !uniq.has(i.link)) uniq.set(i.link, i);
	return { seen, fresh: [...uniq.values()].slice(0, 40) };
}

async function sendTelegram(env, text, silent = false, track = false) {
	const tg = await timedFetch('telegram', `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: env.TELEGRAM_CHAT_ID,
			text: text.slice(0, 4000),
			disable_web_page_preview: true,
			disable_notification: silent,
		}),
	});
	if (!tg.ok) {
		console.error('Telegram failed:', tg.status, await tg.text());
		return false;
	}
	if (track) {
		const data = await tg.json().catch(() => null);
		const id = data?.result?.message_id;
		if (id) {
			const sent = JSON.parse((await env.STATE.get('sent')) || '[]');
			sent.push({ id, t: Date.now() });
			await env.STATE.put('sent', JSON.stringify(sent.slice(-100)));
		}
	}
	return true;
}

const DAY = 24 * 3600 * 1000;
const CLEAN_CRON = '0 14 * * *'; // 21:00 giờ VN, mỗi ngày kể cả cuối tuần

async function cleanup(env) {
	const sent = JSON.parse((await env.STATE.get('sent')) || '[]');
	const keep = [];
	for (const m of sent) {
		if (Date.now() - m.t < DAY) {
			keep.push(m);
			continue;
		}
		// Xóa thất bại (đã xóa tay, quá 48 giờ) thì vẫn bỏ khỏi danh sách, không thử lại mãi
		await timedFetch('telegram delete', `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, message_id: m.id }),
		}).catch(() => {});
	}
	if (keep.length !== sent.length) await env.STATE.put('sent', JSON.stringify(keep));
}

async function discoverModels(env) {
	const res = await timedFetch(
		'list models',
		'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
		{ headers: { 'x-goog-api-key': env.GEMINI_API_KEY } },
		15000,
	);
	if (!res.ok) throw new Error('list models ' + res.status);
	const { models = [] } = await res.json();

	const TIER = { flash: 2, 'flash-lite': 1 };
	const SKIP = /tts|image|live|audio|embed|computer|robotics|vision|thinking|exp|dialog|learnlm/;

	const ranked = models
		.filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
		.map((m) => {
			const name = m.name.replace(/^models\//, '');
			const p = /^gemini-(\d+)(?:\.(\d+))?-(flash-lite|flash)(?:-(.+))?$/.exec(name);
			if (!p) return null;
			const suffix = p[4] || '';
			if (/^\d{3}$/.test(suffix) || SKIP.test(suffix)) return null;
			if (suffix && env.GEMINI_ALLOW_PREVIEW !== '1') return null;
			return { name, ver: +p[1] * 100 + +(p[2] || 0), tier: TIER[p[3]], suffix };
		})
		.filter(Boolean)
		.sort((a, b) => b.tier - a.tier || b.ver - a.ver || a.suffix.length - b.suffix.length);

	const flash = ranked.filter((r) => r.tier === 2).slice(0, 3);
	const lite = ranked.filter((r) => r.tier === 1).slice(0, 2);
	return [...flash, ...lite].map((r) => r.name);
}

async function getModelChain(env) {
	let chain = await env.STATE.get('model_chain', 'json');
	if (!chain?.length) {
		try {
			chain = await discoverModels(env);
			if (chain.length) await env.STATE.put('model_chain', JSON.stringify(chain), { expirationTtl: 86400 });
		} catch (e) {
			console.error('discover models failed:', e.message);
			chain = [];
		}
	}
	// Model cấu hình tay đặt ở cuối làm lưới an toàn khi việc khám phá lỗi
	const manual = [env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL].filter(Boolean);
	return [...new Set([...chain, ...manual])];
}

async function loadBad(env) {
	const bad = (await env.STATE.get('bad_models', 'json')) || {};
	for (const k of Object.keys(bad)) if (bad[k] < Date.now()) delete bad[k];
	return bad;
}

async function markBad(env, bad, model, ms) {
	bad[model] = Date.now() + ms;
	await env.STATE.put('bad_models', JSON.stringify(bad), { expirationTtl: 86400 });
}

async function analyze(env, fresh, budgetMs = 25_000) {
	const list = fresh.map((i, n) => `[${n + 1}] ${i.title}`).join('\n');
	const prompt =
		'Bạn là trợ lý phân tích tin chứng khoán Việt Nam. Chỉ dựa vào danh sách tiêu đề đánh số bên dưới, ' +
		'viết bản tin bằng tiếng Việt, văn bản thuần (không markdown, không in đậm) theo cấu trúc:\n' +
		'1) TIN NÓNG: 4-5 tin thị trường đáng chú ý nhất (biến động, khối ngoại, chính sách, doanh nghiệp lớn), ' +
		'rồi 2-3 tin đời sống ảnh hưởng tới túi tiền (xăng dầu, vàng, tỷ giá, lãi suất, giá cả, bất động sản). ' +
		"Mỗi tin một dòng bắt đầu bằng '•', tin đời sống thêm '🏠' ở đầu dòng, cuối dòng ghi số nguồn [n]. " +
		'Bỏ qua tin giải trí, du lịch, chuyện cá nhân người nổi tiếng.\n' +
		'2) TỔNG QUAN: 2-3 câu về tâm lý thị trường hôm nay.\n' +
		'3) CỔ PHIẾU VỐN HÓA LỚN: chọn tối đa 4 mã vốn hóa lớn được nhắc trong tin ' +
		`(ưu tiên: ${BLUECHIPS}). Mỗi mã viết 2-3 dòng: tín hiệu từ tin tức (tích cực/trung lập/tiêu cực), ` +
		'yếu tố có thể hỗ trợ phục hồi, rủi ro, điều cần theo dõi. Cuối mỗi nhận định ghi số nguồn dạng [n].\n' +
		'Quy tắc: nếu tin không đủ để đánh giá một mã thì bỏ qua mã đó; tuyệt đối không bịa số liệu ' +
		'(giá, P/E, giá mục tiêu); không khuyến nghị mua hay bán; nói rõ đây là nhận định dựa trên tin tức, ' +
		'không phải phân tích kỹ thuật hay định giá.\n\n' +
		'DANH SÁCH TIN:\n' +
		list;

	console.log('prompt length:', prompt.length); // phải dài hàng trăm ký tự, không phải 3

	const chain = await getModelChain(env);
	const bad = await loadBad(env);
	console.log('model chain:', chain.join(', '));
	const deadline = Date.now() + budgetMs;

	for (const model of chain) {
		if (bad[model] > Date.now()) continue;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const left = deadline - Date.now();
			if (left < 4000) {
				console.error('Hết ngân sách thời gian, dừng thử model');
				return null;
			}
			try {
				const res = await timedFetch(
					`gemini ${model} #${attempt}`,
					`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
					{
						method: 'POST',
						headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
						body: JSON.stringify({
							contents: [{ parts: [{ text: prompt }] }],
							generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
						}),
					},
					Math.min(left, 10000),
				);
				if (res.ok) {
					const data = await res.json();
					const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
					if (text && text.length > 150 && /\[\d+\]/.test(text)) {
						console.log('Gemini dùng model:', model);
						return text;
					}
					console.error('Gemini trả lời bất thường:', model, (text || '').slice(0, 100));
					break;
				}
				const body = await res.text();
				console.error('Gemini failed:', model, res.status, body.slice(0, 300));
				if ([500, 503].includes(res.status)) {
					await markBad(env, bad, model, 3 * 60_000);
					break;
				}
				const noFreeQuota = res.status === 429 && /limit:\s*0\b/.test(body);
				const ttl = noFreeQuota || [403, 404].includes(res.status) ? 24 * 3600_000 : res.status === 429 ? 15 * 60_000 : 0;
				if (ttl) await markBad(env, bad, model, ttl);
				break;
			} catch (e) {
				console.error('Gemini error:', model, e.name);
				if (e.name === 'TimeoutError') await markBad(env, bad, model, 10 * 60_000); // model chậm, tạm bỏ qua
				break;
			}
		}
	}
	return null;
}

async function buildDigest(env, items, budgetMs) {
	const summary = await analyze(env, items, budgetMs);
	const body =
		summary ||
		items
			.slice(0, 8)
			.map((i, n) => `• ${i.title} [${n + 1}]`)
			.join('\n');

	const cited = [...new Set([...body.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]))].filter((n) => n >= 1 && n <= items.length).slice(0, 8);
	const idx = cited.length ? cited : [1, 2, 3, 4, 5].filter((n) => n <= items.length);

	const footer =
		'\n\n⚠ Nhận định dựa trên tin tức, chỉ mang tính tham khảo, không phải khuyến nghị đầu tư.' +
		'\n\nNguồn:\n' +
		idx.map((n) => `[${n}] ${items[n - 1].link}`).join('\n');

	const head = getVietnameseDateTime().date;
	return { text: head + body.slice(0, 4000 - head.length - footer.length) + footer, ai: !!summary };
}

function formatHot(items) {
	const market = items.filter((i) => isMarket(i.title)).slice(0, 6);
	const life = items.filter((i) => !isMarket(i.title) && isLife(i.title)).slice(0, 4);
	if (!market.length && !life.length) return null;
	const hhmm = getVietnameseDateTime().time.trim().slice(0, 5);
	const fmt = (i) => `• ${i.title}\n${i.link}`;
	const parts = [`🔥 TIN NÓNG ${hhmm}`];
	if (market.length) parts.push('📈 Thị trường\n' + market.map(fmt).join('\n'));
	if (life.length) parts.push('🏠 Đời sống\n' + life.map(fmt).join('\n'));
	return parts.join('\n\n');
}

async function runHot(env) {
	if (await env.STATE.get('paused')) {
		console.log('paused, bỏ qua');
		return;
	}
	const { seen, fresh } = await collect(env, 'seen_hot');
	console.log('hot mode, fresh =', fresh.length);
	if (!fresh.length) return;

	const text = formatHot(fresh);
	let ok = true;
	if (text) ok = await sendTelegram(env, text); // nếu bạn đã làm phần tự xóa tin, giữ "false, true"
	if (ok) {
		fresh.forEach((i) => seen.add(i.link));
		await env.STATE.put('seen_hot', JSON.stringify([...seen].slice(-300)));
	}
}

async function run(env) {
	if (await env.STATE.get('paused')) {
		console.log('paused, bỏ qua');
		return;
	}
	const { seen, fresh } = await collect(env, 'seen');
	console.log('fresh =', fresh.length);
	if (!fresh.length) return;

	const { text } = await buildDigest(env, fresh, 60000);

	if (await sendTelegram(env, text)) {
		fresh.forEach((i) => seen.add(i.link));
		await env.STATE.put('seen', JSON.stringify([...seen].slice(-300)));
	}
}

async function setPause(env, arg) {
	const text = arg.trim();
	if (!text) {
		await env.STATE.put('paused', 'forever');
		return '⏸ Đã tạm dừng tin tự động. Gõ /resume để bật lại.';
	}
	const m = /^(\d+)\s*(h|d)?$/i.exec(text);
	if (!m || +m[1] === 0) {
		return 'Cú pháp: /pause (đến khi /resume), /pause 8 (8 giờ), /pause 2d (2 ngày).';
	}
	const isDay = m[2]?.toLowerCase() === 'd';
	const ms = +m[1] * (isDay ? 86400_000 : 3600_000);
	// KV tự xóa khóa khi hết hạn, nên bot tự bật lại mà không cần cron
	await env.STATE.put('paused', String(Date.now() + ms), {
		expirationTtl: Math.max(60, Math.round(ms / 1000)),
	});
	return `⏸ Tạm dừng ${m[1]} ${isDay ? 'ngày' : 'giờ'}, sau đó tự bật lại. Gõ /resume để bật sớm.`;
}

async function handleUpdate(env, update) {
	const msg = update.message;
	if (!msg?.text) return;
	if (String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return; // bỏ qua người lạ

	const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase(); // xử lý cả dạng /get@TenBot
	const arg = msg.text.trim().split(/\s+/).slice(1).join(' ');

	if (cmd === '/get') {
		const { fresh } = await collect(env, null);
		await sendTelegram(env, formatHot(fresh) || 'Chưa thấy tin nóng nào trong các nguồn lúc này.');
	} else if (cmd === '/get_analyze') {
		if (await env.STATE.get('cooldown_analyze')) {
			await sendTelegram(env, 'Vừa phân tích xong, đợi vài phút rồi thử lại nhé (để tiết kiệm hạn mức Gemini).', true);
			return;
		}
		await env.STATE.put('cooldown_analyze', '1', { expirationTtl: 60 });
		await sendTelegram(env, '⏳ Đang phân tích, chờ khoảng nửa phút...', true);

		const { fresh } = await collect(env, null);
		if (!fresh.length) {
			await sendTelegram(env, 'Không lấy được tin từ các nguồn lúc này.');
			return;
		}
		const { text, ai } = await buildDigest(env, fresh);
		if (ai) await env.STATE.put('cooldown_analyze', '1', { expirationTtl: 300 });
		await sendTelegram(env, ai ? text : '⚠ Gemini đang bận, đây là tiêu đề thô:\n\n' + text);
	} else if (cmd === '/help' || cmd === '/start') {
		await sendTelegram(
			env,
			'Lệnh:\n/get - tin nóng thị trường và đời sống\n/get_analyze - phân tích bằng AI (cách nhau 5 phút)\n' +
				'/pause [giờ] - tạm dừng tin tự động (vd /pause 8, /pause 2d)\n/resume - bật lại',
			true,
		);
	} else if (cmd === '/pause') {
		await sendTelegram(env, await setPause(env, arg), true);
	} else if (cmd === '/resume') {
		if (await env.STATE.get('paused')) {
			await env.STATE.delete('paused');
			await sendTelegram(env, '▶️ Đã bật lại tin tự động.', true);
		} else {
			await sendTelegram(env, 'Bot đang chạy bình thường, không cần /resume.', true);
		}
	}
}

export default {
	async scheduled(event, env, ctx) {
		const job = event.cron === CLEAN_CRON ? cleanup : event.cron === HOT_CRON ? runHot : run;
		try {
			await job(env);
		} catch (e) {
			console.error('RUN FAILED:', e?.stack || e);
		}
	},
	async fetch(req, env, ctx) {
		const url = new URL(req.url);
		if (req.method === 'POST' && url.pathname === '/telegram') {
			if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
				return new Response('forbidden', { status: 403 });
			}
			const update = await req.json().catch(() => null);
			if (!update) return new Response('ok');

			const key = 'upd:' + update.update_id;
			if (await env.STATE.get(key)) return new Response('ok'); // Telegram gửi lại, bỏ qua
			await env.STATE.put(key, '1', { expirationTtl: 300 });

			try {
				await handleUpdate(env, update);
			} catch (e) {
				console.error('UPDATE FAILED:', e?.stack || e);
			}
			return new Response('ok');
		}
		return new Response('not found', { status: 404 });
	},
};

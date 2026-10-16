const FEEDS = [
	'https://vnexpress.net/rss/kinh-doanh.rss',
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

async function analyze(env, fresh) {
	const list = fresh.map((i, n) => `[${n + 1}] ${i.title}`).join('\n');
	const prompt =
		'Bạn là trợ lý phân tích tin chứng khoán Việt Nam. Chỉ dựa vào danh sách tiêu đề đánh số bên dưới, ' +
		'viết bản tin bằng tiếng Việt, văn bản thuần (không markdown, không in đậm) theo cấu trúc:\n' +
		'1) TỔNG QUAN: 2-3 câu về tâm lý thị trường hôm nay.\n' +
		'2) CỔ PHIẾU VỐN HÓA LỚN: chọn tối đa 4 mã vốn hóa lớn được nhắc trong tin ' +
		`(ưu tiên: ${BLUECHIPS}). Mỗi mã viết 2-3 dòng: tín hiệu từ tin tức (tích cực/trung lập/tiêu cực), ` +
		'yếu tố có thể hỗ trợ phục hồi, rủi ro, điều cần theo dõi. Cuối mỗi nhận định ghi số nguồn dạng [n].\n' +
		'Quy tắc: nếu tin không đủ để đánh giá một mã thì bỏ qua mã đó; tuyệt đối không bịa số liệu ' +
		'(giá, P/E, giá mục tiêu); không khuyến nghị mua hay bán; nói rõ đây là nhận định dựa trên tin tức, ' +
		'không phải phân tích kỹ thuật hay định giá.\n\n' +
		'DANH SÁCH TIN:\n' +
		list;

	console.log('prompt length:', prompt.length); // phải dài hàng trăm ký tự, không phải 3

	const models = [env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL].filter(Boolean);
	for (const model of models) {
		for (let attempt = 1; attempt <= 3; attempt++) {
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
					30000,
				);
				if (res.ok) {
					const data = await res.json();
					const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
					// Bỏ qua câu trả lời ngắn hoặc lạc đề (không có số nguồn [n])
					if (text && text.length > 150) return text;
					console.error('Gemini trả lời bất thường:', (text || '').slice(0, 100));
					break;
				}
				console.error('Gemini failed:', res.status, await res.text());
				if (![429, 500, 503].includes(res.status)) break;
			} catch (e) {
				console.error('Gemini error:', e.name);
			}
			await sleep(attempt * 3000);
		}
	}
	return null;
}

async function run(env) {
	console.log('token set:', !!env.TELEGRAM_TOKEN, 'len:', env.TELEGRAM_TOKEN?.length, 'chat set:', !!env.TELEGRAM_CHAT_ID);

	const seen = new Set(JSON.parse((await env.STATE.get('seen')) || '[]'));
	console.log('KV ok, seen =', seen.size);

	const results = await Promise.allSettled(
		FEEDS.map((u) =>
			timedFetch('feed ' + new URL(u).host + new URL(u).pathname, u, {
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stock-news-bot)' },
			}).then((r) => r.text()),
		),
	);
	console.log(
		'feeds:',
		results.map((r) => r.status),
	);
	const all = results.filter((r) => r.status === 'fulfilled').flatMap((r) => parseItems(r.value));

	const uniq = new Map();
	for (const i of all) {
		if (!seen.has(i.link) && !uniq.has(i.link)) uniq.set(i.link, i);
	}
	const fresh = [...uniq.values()].slice(0, 40); // giới hạn tổng để prompt gọn
	console.log('fresh =', fresh.length);

	if (!fresh.length) return;

	const summary = await analyze(env, fresh);

	// Dự phòng khi LLM lỗi: tiêu đề thô, cũng đánh số để dùng chung cơ chế nguồn
	const body =
		summary ||
		fresh
			.slice(0, 8)
			.map((i, n) => `• ${i.title} [${n + 1}]`)
			.join('\n');

	// Gom các số nguồn được nhắc, giữ thứ tự xuất hiện, tối đa 8
	const cited = [...new Set([...body.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]))].filter((n) => n >= 1 && n <= fresh.length).slice(0, 8);
	const idx = cited.length ? cited : [1, 2, 3, 4, 5].filter((n) => n <= fresh.length);

	const footer =
		'\n\n⚠ Nhận định dựa trên tin tức, chỉ mang tính tham khảo, không phải khuyến nghị đầu tư.' +
		'\n\nNguồn:\n' +
		idx.map((n) => `[${n}] ${fresh[n - 1].link}`).join('\n');

	const text = getVietnameseDateTime().date + body.slice(0, 4000 - footer.length) + footer;

	const tg = await timedFetch('telegram', `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: env.TELEGRAM_CHAT_ID,
			text, // dùng trực tiếp, không cắt hay cộng gì thêm
			disable_web_page_preview: true,
		}),
	});

	// Chỉ đánh dấu "đã gửi" khi Telegram nhận thành công
	if (tg.ok) {
		fresh.forEach((i) => seen.add(i.link));
		await env.STATE.put('seen', JSON.stringify([...seen].slice(-300)));
	} else {
		console.error('Telegram failed:', tg.status, await tg.text());
	}
}

export default {
	async scheduled(event, env, ctx) {
		ctx.waitUntil(run(env).catch((e) => console.error('RUN FAILED:', e?.stack || e)));
	},
	// Chỉ để test, xóa sau khi xong
	async fetch(req, env, ctx) {
		ctx.waitUntil(run(env).catch((e) => console.error('RUN FAILED:', e?.stack || e)));
		return new Response('ok');
	},
};

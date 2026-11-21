// Checks the recorder's gold trades for holes: Binance aggTrade ids are consecutive, so any jump = missing trades.
const r = await fetch('http://localhost:8090/rec/trades?key=binance:XAUUSDT&from=' + (Date.now() - 24 * 3600e3));
const a = new Float64Array(await r.arrayBuffer()), ids = []; for (let i = 0; i < a.length; i += 5) ids.push(a[i + 4]);
ids.sort((x, y) => x - y); let holes = 0, missing = 0, dup = 0;
for (let i = 1; i < ids.length; i++) { if (ids[i] === ids[i - 1]) dup++; else if (ids[i] > ids[i - 1] + 1) { holes++; missing += ids[i] - ids[i - 1] - 1; } }
console.log(`trades ${ids.length.toLocaleString()} from ${new Date(a[0]).toISOString().slice(0, 16)} UTC: holes ${holes}, missing ${missing}, duplicates ${dup}`);

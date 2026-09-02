# 5 lines for the stage — 20:30, 2 September 2026

1. **หนึ่งคลิก** — `Deploy to Cloudflare` → Worker + D1 มาเอง ไม่มี server ไม่มี migration step: `just deploy` แล้ว `curl /api/health` ตอบ `ok` ใน 110 ms.
2. **ติดตั้งบน claude.ai** — Settings → Connectors → Add custom connector → วาง URL `/mcp` → claude.ai เห็น "Authentication: Always required — Detected" เอง → หน้า `/authorize` ของเราถามรหัสเจ้าของ → **Connected**, 9 tools.
3. **จำเป็นไทย** — `remember` ข้อความไทย แล้ว `recall "ความจำ"` เจอกลางคำ (substring, ไม่มี tokenizer) 1/1 ใน ~190 ms; `just dig teamcharter` แตกคำเป็น 4 variants เจอ 2 memories ที่ query ตรง ๆ เจอ 0.
4. **ใครต่ออยู่ เรียกอะไร จากไหน** — `list_clients` บอกว่า claude.ai คือ `Anthropic/ClaudeAI 1.0.0` proto `2025-11-25` ต่อจาก **US/IAD**, Claude Code จาก **TH/BKK**; `list_calls` ไล่ทุก method: `server/discover → initialize → tools/list → tools/call` พร้อม ms — ไม่มี stream, ทุก request เขียนแถวของตัวเอง แล้ว Refresh คือ live.
5. **กู้ได้** — `just backup` export D1 ทั้งก้อน (46 rows, 7 s) → `just restore` ลง D1 local → นับแถวตรงกัน `memories 3 · clients 5 · calls 35`. เสร็จ.

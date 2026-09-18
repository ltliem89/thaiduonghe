# Nhật ký phát triển — Vũ trụ 3D Cosmic Zoom

Nhật ký theo từng phiên làm việc. Lưu ý: mọi thay đổi vào `app.ts`/`index.html`
đều cần chạy `npm run build` rồi commit `dist/app.js` (bundle) cùng source.

---

## Phiên 2026-09-18 — Bề mặt thiên thể kiểu NASA + nhẫn Sao Thổ chi tiết

Mục tiêu: ánh sáng Mặt Trời gần thật hơn và bề mặt Mặt Trời + 8 hành tinh +
vành đai trông giống như NASA công bố. Không thêm file asset — làm bằng procedural
canvas.

### Thay đổi trong `app.ts`

- **Nút ẩn/hiện bảng điều khiển**: sửa text — khi ẩn hiện `☰ Hiện bảng điều khiển`
  (trước đây chỉ `☰ Hiện`), khi hiện vẫn `✕ Ẩn`.

- **Mở rộng `SurfaceSpec`** thêm các pass vẽ mới trong `buildSurface`:
  - `wavy` — dải khí quyển mép lượn sóng (sin), dùng cho hành tinh khí.
  - `swirl` — xoáy/storm dạng ellipse xoay (có bump), dùng cho GRS, vết tối Hải
    Vương, mây Kim Tinh.
  - `polarCaps` — chỏm cực sáng (gradient) dùng cho Trái Đất, Sao Hỏa.
  - `spots` — vết tối lõi + vành sáng + cả bump lõm (vết đen Mặt Trời).
  - `granulation` — ô hạt đối lưu sáng tối kiểu bề mặt Mặt Trời.
  - `cloudLayer` — vệt mây bán trong suốt (mây Trái Đất).

- **Cập nhật từng bề mặt**:
  - **Mặt Trời**: base vàng nóng, granulation size 12, 16 vết đen (lõi nâu sẫm),
    bớt blob để không che hạt đối lưu.
  - **Trái Đất**: chỏm cực trắng, mây trắng bán trong suốt, biển sâu hơn
    (`#2f6fd0` + lớp nước đậm), đất xanh + rìa sa mạc.
  - **Sao Hỏa**: chỏm cực nhỏ nhạt, thêm 2 vùng tối lớn + chấm đen (điểm núi lửa).
  - **Sao Mộc**: 8 dải wavy + Great Red Spot (tây-nam bán cầu, `cx .72 cy .62`)
    + 3 cơn bão tròn nhỏ + quầng nhạt quanh xích đạo.
  - **Sao Thổ**: wavy nhẹ 6 dải kem/ánh đồng.
  - **Sao Thiên Vương**: 3 dải wavy rất mờ + vùng sáng.
  - **Sao Hải Vương**: 4 dải wavy xanh + Great Dark Spot (`cx .45 cy .62`).
  - **Kim Tinh**: bỏ `bands`, dùng wavy che kín bầu khí quyển + 1 xoáy to mây.
  - **Mặt Trăng**: thêm blob tối (vùng biển mare) + vùng sáng núi.

- **Vành đai (bỏ texture dải ngang 1024×64)** — hàm mới `buildRingTexture()`
  vẽ **hình tròn đồng tâm** trên canvas vuông 1024 (khớp UV phẳng của
  `RingGeometry`):
  - C-ring mờ nâu đồng → B-ring kem sáng → **Khe Cassini** đen kịt + 1 vạch sáng
    mảnh ở giữa → A-ring xám ngọc + **Khe Encke** hẹp → mép ngoài mờ dần.
  - Ringlet nhỏ tần số cao + grain nhiễu mỗi pixel — đúng "sóng mật độ".
  - Một texture dùng chung: `RING_TEX`.
- **Thêm nhẫn cho Sao Thiên Vương & Hải Vương** (mới có ở `PlanetSpec`):
  `ringOpacity`, `ringInner`, `ringOuter`. Uranus: mờ 45%, vành từ 1.6→2.0R.
  Neptune: mờ 35%, vành 1.45→1.85R. Phần texture rơi vào vùng B→A nên hiện ra
  nhẫn mảnh + 1-2 vạch đẹp như thật.

### Build & deploy

- `npm run build` → `dist/app.js` 1010.3kb (có `buildRingTexture`, `RING_TEX`,
  văn bản nút panel).
- Test `http://127.0.0.1:8081/dist/app.js` → HTTP 200.
- Commit + push lên `github.com/ltliem89/thaiduonghe` (bundle mới cùng source).

---

## Phiên trước (tóm tắt) — 2026

- Sửa lỗi runtime TDZ `cosmosLabels` (Cannot read 'push' of undefined) — khai báo
  mảng label trước hàm dùng.
- Zoom về hệ Mặt Trời chậm còn 20%.
- Dropdown bám theo hành tinh (Sun, Mercury…Neptune, Moon); chọn Mặt Trời → về
  trung tâm, hiện full hệ trong giao diện.
- Chữ tên hành tinh to dần theo khoảng cách zoom (11→19px).
- Ánh sáng Mặt Trời +20% (`sunLight` 0.048).
- Sao mờ dần theo khoảng cách tới tâm lớp (`dim` param của `makePoints`, 10 lớp).
- Đưa dự án lên GitHub + Vercel (vercel.json `outputDirectory:"."`).
- Thanh cuộn chuột: "gờ giảm tốc" tại mức full hệ Mặt Trời (vẫn có thể phóng tiếp).
- Nút ẩn/hiện bảng điều khiển bên phải.
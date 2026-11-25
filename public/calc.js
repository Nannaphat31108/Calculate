// สูตรคำนวณและเรตราคา ใช้ร่วมกันทั้งหน้าเว็บและเซิร์ฟเวอร์
(function (root) {
  // เรตราคา: [รอบวงต่ำสุด, รอบวงสูงสุด, บาท/ลบ.ม.]
  const RATES = {
    teak: [
      [40, 49, 2700], [50, 79, 3700], [80, 89, 4700], [90, 99, 5700],
      [100, 109, 7000], [110, 119, 7500], [120, 129, 8000], [130, 139, 9000], [140, 149, 10000],
      [150, 159, 11000], [160, 169, 12000], [170, 190, 13000]
    ],
    padauk: [
      [70, 79, 5000], [80, 89, 6000], [90, 99, 7000], [100, 109, 8000], [110, 119, 9000],
      [120, 129, 10000], [130, 139, 11000], [140, 149, 12000], [150, 159, 13000],
      [160, 169, 14000], [170, 179, 15000], [180, 189, 16000]
    ]
  };
  const NAME = { teak: "ไม้สัก", padauk: "ไม้ประดู่" };

  // ปริมาตรต่อต้น (ลบ.ม.) = รอบวง(ซม.) × รอบวง × ความยาว(ม.) × 7.96 / 1,000,000
  function getVolume(g, len) { return g * g * len * 7.96 / 1000000; }
  function getRate(type, g) {
    if (!RATES[type]) return null;
    const gi = Math.floor(g);
    const r = RATES[type].find(([lo, hi]) => gi >= lo && gi <= hi);
    return r ? r[2] : null;
  }
  function calc(type, g, len, qty) {
    if (!RATES[type]) return { error: "ชนิดไม้ไม่ถูกต้อง" };
    if (!(g > 0)) return { error: "กรุณากรอกรอบวง" };
    if (!(len > 0)) return { error: "กรุณากรอกความยาว" };
    if (!(Number.isInteger(qty) && qty >= 1)) return { error: "จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1" };
    const rate = getRate(type, g);
    if (rate == null) {
      const list = RATES[type];
      return { error: `${NAME[type]}รับซื้อรอบวง ${list[0][0]}–${list[list.length - 1][1]} ซม. เท่านั้น` };
    }
    const vol = getVolume(g, len);
    const volTotal = vol * qty;
    return { type, g, len, qty, rate, vol, volTotal, total: volTotal * rate };
  }

  const api = { RATES, NAME, getVolume, getRate, calc };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WoodCalc = api;
})(this);

// Шейдеры ядра: один полноэкранный проход. Все элементы — аналитические формы с антиалиасингом
// в 1 пиксель устройства; свечение — экспоненциальные «ореолы» вокруг линий, без отдельного bloom.
// Изнутри наружу: плазма → кольцо с делениями → сегментные дуги → столбики → отсчёт/прогресс → лимб.

import { glslConstants } from './orbGeometry'

/** Полноэкранный треугольник без буферов вершин. */
export const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

const float TAU = 6.28318530718;
const float PI = 3.14159265359;
${glslConstants()}

uniform vec2 uCenter;      // центр холста, px устройства
uniform float uScale;      // R в px устройства
uniform float uPx;         // 1 px устройства в долях R
uniform float uLine;       // «1 CSS px» линии в долях R
uniform vec3 uColor;
uniform vec4 uCore;        // радиус, яркость, турбулентность, —
uniform vec3 uSpin;        // фазы вращения плазмы
uniform vec4 uRot;         // кольцо, дуги A, дуги B, лимб
uniform vec4 uBars;        // база, звук, волна, —
uniform vec4 uBarPhase;
uniform vec4 uThink;       // развёртка, угол развёртки, частицы, —
uniform vec4 uChase;       // сила, голова, длина, —
uniform vec4 uCountdown;   // яркость, доля, —, —
uniform vec4 uFx;          // энергия, вспышка, сжатие, —
uniform vec2 uShock;       // прогресс, яркость
uniform vec2 uRipple;      // сила, фаза
uniform vec3 uAmber;
uniform vec3 uRed;
uniform vec3 uGrey;
uniform vec4 uParticles[PARTICLES];

out vec4 outColor;

float gPx;  // пиксель в долях R с учётом сжатия

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash31(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(hash31(i), hash31(i + vec3(1, 0, 0)), u.x);
  float b = mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), u.x);
  float c = mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), u.x);
  float d = mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * vnoise(p);
    p = p * 2.07 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum / 0.875;
}

vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

vec3 rotX(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

// Покрытие линии полутолщиной hw на расстоянии d. Тоньше пикселя — линия остаётся в 1 px, но тускнеет:
// так тонкие детали не рассыпаются в «лесенку».
float stroke(float d, float hw) {
  float w = max(hw, 0.5 * gPx);
  return clamp((w - abs(d)) / gPx + 0.5, 0.0, 1.0) * (hw / w);
}

// Отрезок [a, b] по радиусу со сглаженными краями.
float span(float x, float a, float b) {
  return clamp((x - a) / gPx + 0.5, 0.0, 1.0) * clamp((b - x) / gPx + 0.5, 0.0, 1.0);
}

// Дуга [s, s + l] в угловой системе ang ∈ [0, TAU); край размыт на soft (доли R) по длине дуги на радиусе r.
// soft = gPx — чёткий край линии; шире — мягкая маска для ореола, чтобы свечение не обрывалось ступенькой.
float arcMask(float ang, float s, float l, float r, float soft) {
  if (l >= TAU) return 1.0;  // полная окружность — без шва на старте
  float rel = mod(ang - s, TAU);
  float d = rel < l ? min(rel, l - rel) : -min(rel - l, TAU - rel);
  return clamp(d * r / soft + 0.5, 0.0, 1.0);
}

// Штриховка дуги. На маленьком ядре штрихи в 2–3 пикселя дают муар, поэтому, когда шаг меньше
// ~8 px, они плавно сливаются в сплошную линию средней яркости.
float dashMask(float ang, float s, float dash, float r) {
  float local = mod(mod(ang - s, TAU), dash);
  float d = min(local, dash * ARC_DUTY - local);
  float crisp = clamp(d * r / gPx + 0.5, 0.0, 1.0);
  return mix(ARC_DUTY * 0.85, crisp, smoothstep(5.0, 9.0, dash * r / gPx));
}

// Расстояние по дуге до ближайшего из n равномерных делений и номер деления.
float tickDistance(float ang, float n, float r, out float index) {
  float cell = ang / TAU * n;
  float k = floor(cell + 0.5);
  index = mod(k, n);
  return (cell - k) * TAU / n * r;
}

vec3 plasma(vec2 p, float r) {
  float rad = uCore.x;
  float q = r / rad;
  float boost = uCore.y;
  float turb = uCore.z;
  // Гало вокруг сферы и широкая дымка; внутри гало постоянно — переход через край непрерывен.
  float halo = 0.3 * exp(-max(q - 1.0, 0.0) * 5.0) + 0.06 / (1.0 + q * q * q);
  vec3 col = uColor * halo * boost;
  if (q < 1.0) {
    float z = sqrt(1.0 - q * q);
    // Закрутка: внутренние слои повёрнуты сильнее — плазма выглядит вихрем, а не картой.
    float tw = (1.0 - q) * (1.4 + 1.2 * turb);
    float ct = cos(tw), st = sin(tw);
    vec2 pq = mat2(ct, st, -st, ct) * (p / rad);
    vec3 sp = rotX(rotY(vec3(pq, z), uSpin.x), 0.35 + 0.25 * sin(uSpin.y));
    float warp = fbm(rotY(sp, uSpin.z) * 1.3 + vec3(4.1, 0.0, 2.3));
    float n = fbm(sp * 2.2 + warp * (0.6 + 1.0 * turb));
    float wisps = smoothstep(0.35, 0.85, n);
    float ridge = 1.0 - abs(2.0 * n - 1.0);
    float filaments = ridge * ridge * ridge;
    float threads = pow(ridge, 9.0);
    float body = pow(1.0 - q * q, 0.9);
    float edge = 1.0 - smoothstep(0.88, 1.0, q);
    float limb = smoothstep(0.66, 0.95, q) * edge;
    float center = exp(-q * q * 3.0);
    float lum = body * (0.15 + 0.55 * wisps + 0.22 * filaments + 0.5 * threads) + center * 0.72 + limb * 0.22;
    col += uColor * lum * edge * boost;
    col += vec3(1.0) * exp(-q * q * 7.0) * (0.38 + 0.2 * wisps) * boost;
  }
  return col;
}

void main() {
  vec2 p0 = (gl_FragCoord.xy - uCenter) / uScale;
  float r0 = length(p0);
  // «Стоп»: вся конструкция сжимается к центру; линии при этом остаются в 1 px.
  float collapse = uFx.z;
  float scale = mix(1.0, COLLAPSED, collapse) * (1.0 + 0.03 * uFx.y);
  vec2 p = p0 / scale;
  float r = r0 / scale;
  gPx = uPx / scale;
  float lw = uLine / scale;
  float a = atan(p.y, p.x + 1e-7);
  float cw = mod(PI * 0.5 - a, TAU);  // по часовой от «12 часов»

  vec3 c = uColor;
  float e = uFx.x;
  float rings = e * (1.0 - 0.55 * collapse);
  vec3 col = vec3(0.0);

  // Фоновая дымка между ядром и лимбом.
  float hz = (r - 0.42) / 0.2;
  col += c * 0.045 * exp(-hz * hz) * e;

  col += plasma(p, r);

  // Говорю: тонкие волны расходятся от ядра наружу — «голос» идёт из центра.
  if (uRipple.x > 0.001 && r > uCore.x && r < DIAL_R) {
    float wv = max(sin(r * TAU / RIPPLE_STEP - uRipple.y), 0.0);
    float fade = smoothstep(uCore.x, uCore.x + 0.04, r) * (1.0 - smoothstep(0.3, DIAL_R, r));
    col += c * pow(wv, 24.0) * fade * uRipple.x * 0.55;
  }

  // 2. Внутреннее кольцо с 72 делениями (каждое шестое длиннее).
  if (r > RING_R - 0.04 && r < RING_R + 0.03) {
    float k;
    float d = tickDistance(mod(a - uRot.x, TAU), RING_TICKS, r, k);
    float major = 1.0 - step(0.5, mod(k, 6.0));
    float len = mix(0.009, 0.02, major);
    float ticks = stroke(d, lw * 0.5) * span(r, RING_R - len - 0.004, RING_R - 0.004) * mix(0.55, 1.0, major);
    float line = stroke(r - RING_R, lw * 0.55);
    col += c * (line * 1.5 + ticks * 1.1) * rings;
  }
  col += c * exp(-abs(r - RING_R) / 0.006) * 0.12 * rings;

  // 3. Сегментные дуги: толстые и тонкие вращаются навстречу.
  if (r > ARC_R_A - 0.02 && r < ARC_R_B + 0.02) {
    float aa = mod(a - uRot.y, TAU);
    float bandA = stroke(r - ARC_R_A, lw * 1.35);
    float glowA = exp(-abs(r - ARC_R_A) / 0.007);
    float segA = 0.0;
    float haloA = 0.0;  // ореол — по мягкой маске без штриховки: общий для всего сегмента
    for (int i = 0; i < ARCS_A_N; i++) {
      vec3 s = ARCS_A[i];
      float m = arcMask(aa, s.x, s.y, r, gPx);
      float dashed = step(0.0001, s.z);
      segA += m * mix(1.0, dashMask(aa, s.x, s.z, r), dashed);
      haloA += arcMask(aa, s.x, s.y, r, 0.03) * mix(1.0, ARC_DUTY, dashed);
    }
    float ab = mod(a - uRot.z, TAU);
    float bandB = stroke(r - ARC_R_B, lw * 0.5);
    float segB = 0.0;
    for (int i = 0; i < ARCS_B_N; i++) {
      vec3 s = ARCS_B[i];
      segB += arcMask(ab, s.x, s.y, r, gPx);
    }
    col += c * (segA * bandA * 1.9 + haloA * glowA * 0.22 + segB * bandB * 1.4) * rings;
  }

  // 4. Столбики — круговой эквалайзер.
  if (r > BAR_IN - 0.01 && r < BAR_OUT + 0.02) {
    float k;
    float d = tickDistance(a, BAR_N, r, k);
    float phi = k / BAR_N * TAU;
    float h = hash11(k * 1.37 + 0.5);
    float wave = (0.5 + 0.5 * sin(3.0 * phi + uBarPhase.x)) * (0.5 + 0.5 * sin(5.0 * phi - uBarPhase.y + 1.3));
    float jitter = 0.5 + 0.5 * sin((1.0 + floor(h * 3.0)) * uBarPhase.z + h * TAU);
    float audio = 0.15 + 0.85 * pow(wave * 0.4 + jitter * 0.6, 1.4);
    float len = uBars.x + uBars.y * audio * BAR_AUDIO + uBars.z * wave * BAR_WAVE;
    len = min(len, BAR_OUT - BAR_IN);
    float hw = 0.11 * TAU * BAR_IN / BAR_N;
    float along = span(r, BAR_IN, BAR_IN + len);
    float t = clamp((r - BAR_IN) / max(len, 1e-4), 0.0, 1.0);
    float body = stroke(d, hw) * along;
    // Ореол узкий (на границе ячейки < 1 %) и мягко гаснет за концами столбика — без «коробок» свечения.
    float beyond = max(BAR_IN - r, 0.0) + max(r - BAR_IN - len, 0.0);
    float glow = exp(-abs(d) / (hw * 1.5) - beyond / 0.005) * 0.2;
    float shade = mix(1.25, 0.75, t) + 0.5 * smoothstep(0.7, 1.0, t);
    col += mix(c, vec3(1.0), 0.12 * t) * (body * shade + glow) * rings;
  }

  // 6. Отсчёт подтверждения: янтарная дуга тает от полной к пустой (по часовой от «12»).
  if (uCountdown.x > 0.001 && abs(r - COUNT_R) < 0.05) {
    float l = uCountdown.y * TAU;
    float on = arcMask(cw, 0.0, l, r, gPx);
    float soft = arcMask(cw, 0.0, l, r, 0.03);
    float band = stroke(r - COUNT_R, lw * 1.2);
    float track = stroke(r - COUNT_R, lw * 0.45) * 0.22;
    // Яркая «голова» у тающего конца; на полном кольце (отсчёт не начат) её нет — иначе шов на «12».
    float head = exp(-max(l - cw, 0.0) * r / 0.025) * on * (1.0 - smoothstep(0.97, 1.0, uCountdown.y));
    float glow = exp(-abs(r - COUNT_R) / 0.01) * 0.3;
    vec3 amber = uAmber * uCountdown.x * (1.0 - 0.55 * collapse);
    col += amber * (band * (on * 1.8 + head * 1.6) + track + glow * (soft + head));
  }

  // 8. Выполняю: «догоняющая» дуга прогресса на том же радиусе.
  if (uChase.x > 0.001 && abs(r - COUNT_R) < 0.05) {
    float on = arcMask(cw, uChase.y - uChase.z, uChase.z, r, gPx);
    float soft = arcMask(cw, uChase.y - uChase.z, uChase.z, r, 0.03);
    float band = stroke(r - COUNT_R, lw * 1.0);
    float headAng = mod(uChase.y - cw, TAU);
    float head = exp(-headAng * r / 0.03) * on;
    float glow = exp(-abs(r - COUNT_R) / 0.01) * 0.3;
    col += c * uChase.x * rings * (band * (on * 1.5 + head * 1.4) + glow * (soft * 0.6 + head));
  }

  // 5. Внешний лимб: шкала, редкие метки-«глифы» и треугольные риски по сторонам света.
  if (r > DIAL_R - 0.04 && r < DIAL_R + 0.03) {
    float k;
    float d = tickDistance(mod(a - uRot.w, TAU), DIAL_N, r, k);
    float major = 1.0 - step(0.5, mod(k, 5.0));
    float len = mix(0.006, 0.015, major);
    float ticks = stroke(d, lw * 0.45) * span(r, DIAL_R + 0.004, DIAL_R + 0.004 + len) * mix(0.5, 0.9, major);
    float ring = stroke(r - DIAL_R, lw * 0.45);
    float glyph = 0.0;
    for (int i = 0; i < GLYPHS_N; i++) {
      float g0 = GLYPHS[i];
      glyph += step(g0, k) * step(k, g0 + GLYPH_LEN - 0.5) * step(0.42, hash11(k * 2.71 + 3.0));
    }
    float dots = glyph * stroke(d, lw * 0.9) * span(r, DIAL_R - 0.016, DIAL_R - 0.0105);
    float cardinal = 1.0 - step(0.5, mod(k, 30.0));
    float inner = DIAL_R - 0.026;
    float tri = cardinal * span(r, inner, DIAL_R - 0.006) * stroke(d, (r - inner) * 0.42 + lw * 0.2);
    col += c * (ring * 0.7 + ticks * 0.75 + dots * 0.9 + tri * 1.1) * rings * 0.75;
  }

  // 7. Думаю: развёртка-локатор и частицы на орбитах.
  if (uThink.x > 0.001 || uThink.z > 0.001) {
    float zone = smoothstep(THINK_IN, THINK_IN + 0.12, r) * (1.0 - smoothstep(THINK_OUT - 0.16, THINK_OUT, r));
    float behind = mod(uThink.y - cw, TAU);
    // Хвост локатора: яркий у ведущего края и длинный едва заметный шлейф; передний край сглажен в 1 px.
    float wedge = (0.26 * exp(-behind * 4.0) + 0.05 * exp(-behind * 0.9)) * (1.0 - smoothstep(4.8, TAU, behind));
    wedge *= clamp(behind * r / gPx + 0.5, 0.0, 1.0);
    // Ведущая линия — со знаком расстояния, чтобы сглаживание и ореол были с обеих сторон.
    float sb = (behind < PI ? behind : behind - TAU) * r;
    float edge = stroke(sb, lw * 0.6) * 0.45 + exp(-abs(sb) / 0.008) * 0.16 + exp(-behind * r / 0.012) * 0.08;
    col += c * uThink.x * zone * (wedge + edge) * rings;
    if (uThink.z > 0.001 && r > THINK_IN - 0.02 && r < THINK_OUT + 0.02) {
      float acc = 0.0;
      for (int i = 0; i < PARTICLES; i++) {
        vec4 pt = uParticles[i];
        vec2 dv = p - pt.xy;
        float reach = pt.z * 10.0;  // дальше ореол < 2 % — не считаем экспоненту
        if (dot(dv, dv) < reach * reach) {
          float d = length(dv);
          acc += pt.w * (clamp((pt.z - d) / gPx + 0.5, 0.0, 1.0) + 0.4 * exp(-d / (pt.z * 2.5)));
        }
      }
      col += mix(c, vec3(1.0), 0.4) * acc * uThink.z * rings * 1.2;
    }
  }

  // 9. Ошибка: вспышка и ударная волна.
  float flash = uFx.y;
  if (flash > 0.001) {
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, uRed * lum * 1.6, min(1.0, flash * 0.75));
    col += uRed * flash * (0.5 * exp(-r * 4.5) + 0.1 * exp(-r * r * 6.0));
    float sr = mix(0.24, 0.66, uShock.x);
    col += uRed * uShock.y * (stroke(r - sr, lw * 1.4) * 1.6 + exp(-abs(r - sr) / 0.015) * 0.35);
  }

  // 10. «Стоп»: обесцвечивание в серый.
  if (collapse > 0.001) {
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, uGrey * lum * 2.2, collapse * 0.85);
  }

  // Края квадрата: свечение гаснет раньше, чем упрётся в границу холста.
  col *= 1.0 - smoothstep(HALF_SIDE * 0.84, HALF_SIDE, r0);

  // Мягкий тон-маппинг по максимальной компоненте: цвет сохраняется, белым пятном не «выгорает».
  float m = max(col.r, max(col.g, col.b));
  col *= (1.0 - exp(-m * 1.15)) / max(m, 1e-5);
  // Дизеринг против полос в мягких градиентах свечения.
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0 * step(0.004, m);
  col = max(col, 0.0);
  float alpha = min(1.0, max(col.r, max(col.g, col.b)));
  outColor = vec4(col, alpha);
}
`

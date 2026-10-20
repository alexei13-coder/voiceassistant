// Шейдеры ядра: один полноэкранный проход. Все элементы — аналитические формы с антиалиасингом
// в 1 пиксель устройства. Минимализм: мягкая плазма, одно тонкое кольцо (на нём же дуги «думаю»,
// отсчёт подтверждения и прогресс выполнения), редкие столбики уровня звука и одна волна «говорю».
// Свечение — только у плазмы; линии остаются чистыми волосяными штрихами без ореолов.

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
uniform float uLine;       // толщина волосяной линии в долях R
uniform vec3 uColor;
uniform vec4 uCore;        // радиус, яркость, турбулентность, энергия
uniform vec3 uSpin;        // фазы вращения плазмы
uniform vec4 uRing;        // яркость кольца, основная дуга, вторая дуга, угол головы
uniform vec2 uArcLen;      // длины основной и второй дуги
uniform vec4 uBars;        // база, звук, волна, видимость
uniform vec3 uBarPhase;
uniform vec3 uChase;       // сила, голова, длина
uniform vec2 uCountdown;   // яркость, доля
uniform vec2 uRipple;      // сила, путь 0..1
uniform vec2 uFx;          // вспышка, сжатие
uniform vec3 uAmber;
uniform vec3 uRed;
uniform vec3 uGrey;

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

// Точка кольца радиуса rad под углом ang по часовой от «12 часов».
vec2 onRing(float ang, float rad) {
  return rad * vec2(sin(ang), cos(ang));
}

// Сплошная дуга [s, s + len] по часовой со скруглёнными концами; rd — расстояние до окружности.
float capArc(vec2 p, float cw, float rd, float s, float len, float rad, float hw) {
  if (len >= TAU - 1e-3) return stroke(rd, hw);
  if (mod(cw - s, TAU) <= len) return stroke(rd, hw);
  float d = min(length(p - onRing(s, rad)), length(p - onRing(s + len, rad)));
  // Нулевая дуга не должна оставлять точку-«огрызок» от скруглений.
  return stroke(d, hw) * smoothstep(0.0, 0.03, len);
}

// Дуга-«комета» на кольце: скруглённая голова под углом head, хвост длиной len плавно растворяется,
// поэтому обрыва нет ни с одной стороны.
float comet(vec2 p, float cw, float rd, float head, float len, float hw) {
  float behind = mod(head - cw, TAU);
  float body = 0.0;
  if (behind < len) {
    float t = 1.0 - behind / len;
    body = stroke(rd, hw) * t * (2.0 - t);
  }
  return max(body, stroke(length(p - onRing(head, RING_R)), hw));
}

// Расстояние по дуге до ближайшего из n равномерных делений и номер деления.
float tickDistance(float ang, float n, float r, out float index) {
  float cell = ang / TAU * n;
  float k = floor(cell + 0.5);
  index = mod(k, n);
  return (cell - k) * TAU / n * r;
}

// Плазма: мягко светящаяся сфера — светлее к центру, с тонким ободком и медленными течениями внутри.
// Контраст течений низкий, центр не «выгорает» в белое.
vec3 plasma(vec2 p, float r) {
  float rad = uCore.x;
  float q = r / rad;
  float boost = uCore.y;
  float turb = uCore.z;
  // Короткий ореол у края и едва заметная дымка дальше; внутри ореол постоянен — край непрерывен.
  float halo = 0.2 * exp(-max(q - 1.0, 0.0) * 4.5) + 0.02 / (1.0 + q * q * q);
  vec3 col = uColor * halo * boost;
  if (q < 1.0) {
    float z = sqrt(1.0 - q * q);
    // Закрутка: внутренние слои повёрнуты сильнее — течение выглядит вихрем, а не картой.
    float tw = (1.0 - q) * (1.1 + 0.9 * turb);
    float ct = cos(tw), st = sin(tw);
    vec2 pq = mat2(ct, st, -st, ct) * (p / rad);
    vec3 sp = rotX(rotY(vec3(pq, z), uSpin.x), 0.35 + 0.25 * sin(uSpin.y));
    float warp = fbm(rotY(sp, uSpin.z) * 1.2 + vec3(4.1, 0.0, 2.3));
    float n = fbm(sp * 1.9 + warp * (0.5 + 0.8 * turb));
    float wisps = smoothstep(0.3, 0.9, n);
    float ridge = 1.0 - abs(2.0 * n - 1.0);
    float edge = 1.0 - smoothstep(0.93, 1.0, q);
    // Свет плавно спадает от центра к краю; облака лишь слегка меняют яркость и оттенок.
    float shade = 0.48 + 0.52 * exp(-q * q * 2.2);
    float lum = shade + ((wisps - 0.5) * 0.24 + 0.06 * ridge * ridge) * z;
    vec3 tone = mix(uColor * 0.88, mix(uColor, vec3(1.0), 0.26), wisps * z);
    col += tone * lum * edge * boost * 1.2;
    col += vec3(1.0) * exp(-q * q * 4.0) * 0.16 * boost;
  }
  return col;
}

void main() {
  vec2 p0 = (gl_FragCoord.xy - uCenter) / uScale;
  float r0 = length(p0);
  float flash = uFx.x;
  // «Стоп»: вся конструкция сжимается к центру; линии при этом остаются волосяными.
  float collapse = uFx.y;
  float scale = mix(1.0, COLLAPSED, collapse) * (1.0 + 0.012 * flash);
  vec2 p = p0 / scale;
  float r = r0 / scale;
  gPx = uPx / scale;
  float hw = 0.5 * uLine / scale;  // полутолщина волосяной линии
  float a = atan(p.y, p.x + 1e-7);
  float cw = mod(PI * 0.5 - a, TAU);  // по часовой от «12 часов»

  vec3 c = uColor;
  float lines = uCore.w * (1.0 - 0.45 * collapse);
  vec3 col = plasma(p, r);

  // Говорю: одна тонкая волна расходится от плазмы и гаснет — «голос» идёт из центра.
  if (uRipple.x > 0.001) {
    float t = uRipple.y;
    float rr = mix(uCore.x * 1.05, RIPPLE_END, t);
    float fade = (1.0 - t) * (1.0 - t) * smoothstep(0.0, 0.12, t);
    col += c * stroke(r - rr, hw) * fade * uRipple.x * 0.8 * lines;
  }

  // Кольцо и всё, что на нём: дуги «думаю», отсчёт подтверждения, прогресс выполнения.
  float rd = r - RING_R;
  if (abs(rd) < 0.03) {
    col += c * stroke(rd, hw) * uRing.x * 0.7 * lines;
    float ahw = hw * 1.5;  // активные дуги — полтора пикселя
    float act = 1.8 * lines;  // яркость активных дуг
    if (uRing.y > 0.001) col += c * comet(p, cw, rd, uRing.w, uArcLen.x, ahw) * uRing.y * act;
    if (uRing.z > 0.001) col += c * comet(p, cw, rd, uRing.w + PI, uArcLen.y, ahw) * uRing.z * act;
    // Отсчёт: янтарная дуга тает от полной к пустой (по часовой от «12»).
    if (uCountdown.x > 0.001) {
      float on = capArc(p, cw, rd, 0.0, uCountdown.y * TAU, RING_R, ahw);
      col += uAmber * on * uCountdown.x * 1.6 * (1.0 - 0.45 * collapse);
    }
    // Выполняю: одна «догоняющая» дуга.
    if (uChase.x > 0.001) col += c * comet(p, cw, rd, uChase.y, uChase.z, ahw) * uChase.x * act;
  }

  // Столбики — редкий круговой индикатор уровня; кончики гаснут, чтобы не было «забора».
  if (uBars.w > 0.001 && r > BAR_IN - 0.01 && r < BAR_OUT + 0.01) {
    float k;
    float d = tickDistance(a, BAR_N, r, k);
    float phi = k / BAR_N * TAU;
    float h = hash11(k * 1.37 + 0.5);
    float wave = (0.5 + 0.5 * sin(3.0 * phi + uBarPhase.x)) * (0.5 + 0.5 * sin(5.0 * phi - uBarPhase.y + 1.3));
    float jitter = 0.5 + 0.5 * sin((1.0 + floor(h * 3.0)) * uBarPhase.z + h * TAU);
    float audio = 0.15 + 0.85 * pow(wave * 0.4 + jitter * 0.6, 1.4);
    float len = uBars.x + uBars.y * audio * BAR_AUDIO + uBars.z * wave * BAR_WAVE;
    len = min(len, BAR_OUT - BAR_IN);
    // Капсула вдоль радиуса: скруглённые концы, ровная толщина.
    float beyond = max(BAR_IN - r, 0.0) + max(r - BAR_IN - len, 0.0);
    float body = stroke(length(vec2(d, beyond)), hw);
    float t = clamp((r - BAR_IN) / max(len, 1e-4), 0.0, 1.0);
    col += c * body * mix(1.0, 0.3, t) * uBars.w * 0.85 * lines;
  }

  // Ошибка: мягкий красный оттенок и короткое тёплое свечение плазмы.
  if (flash > 0.001) {
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, uRed * lum * 1.5, min(1.0, flash * 0.6));
    col += uRed * flash * 0.2 * exp(-r * 7.0);
  }

  // «Стоп»: обесцвечивание в серый.
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

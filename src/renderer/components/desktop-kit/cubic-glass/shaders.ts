export const MAX_GRADIENT_BLOBS = 8
export const MAX_GRADIENT_ENVELOPES = 2

export const CUBIC_GLASS_VERTEX_SHADER = `#version 300 es
const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

void main() {
  gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0);
}
`

export const CUBIC_GLASS_FRAGMENT_SHADER = `#version 300 es
precision highp float;

out vec4 outColor;

uniform vec2 u_resolution;
uniform vec2 u_glow_offset;
uniform vec3 u_cell;
uniform float u_lower_falloff;
uniform vec4 u_blob_geometry[${MAX_GRADIENT_BLOBS}];
uniform vec4 u_blob_color[${MAX_GRADIENT_BLOBS}];
uniform vec4 u_envelope_geometry[${MAX_GRADIENT_ENVELOPES}];
uniform vec4 u_envelope_params[${MAX_GRADIENT_ENVELOPES}];

struct GradientSample {
  vec3 premul;
  float alpha;
  float energy;
};

float roundedBoxSdf(vec2 point, vec2 halfSize, float radius) {
  vec2 q = abs(point) - halfSize + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}

float sampleEnvelope(vec2 uv) {
  float envelopeSum = 0.0;
  for (int index = 0; index < ${MAX_GRADIENT_ENVELOPES}; index++) {
    vec4 geometry = u_envelope_geometry[index];
    vec4 parameters = u_envelope_params[index];
    float verticalRadius = geometry.w * mix(
      parameters.x,
      1.0,
      step(geometry.y, uv.y)
    );
    float verticalDelta = (uv.y - geometry.y) / max(verticalRadius, 0.0001);
    float widthProgress = pow(
      1.0 - smoothstep(0.0, 1.0, clamp(verticalDelta, 0.0, 1.0)),
      1.5
    );
    float belowProgress = smoothstep(
      0.0,
      1.0,
      clamp(-verticalDelta, 0.0, 1.0)
    );
    float lowerWidthScale = parameters.z +
      (parameters.z - 1.0) * 1.5 * belowProgress;
    float horizontalRadius = geometry.z * mix(
      1.0,
      lowerWidthScale,
      widthProgress
    );
    vec2 radius = vec2(horizontalRadius, verticalRadius);
    vec2 q = (uv - geometry.xy) / max(radius, vec2(0.0001));
    float shape = pow(abs(q.x), parameters.w) + q.y * q.y;
    envelopeSum += exp(-shape * 2.15) * parameters.y;
  }
  return envelopeSum;
}

GradientSample sampleGradient(vec2 uv) {
  vec2 glowUv = uv - u_glow_offset;
  vec3 colorSum = vec3(0.0);
  float weightSum = 0.0;

  for (int index = 0; index < ${MAX_GRADIENT_BLOBS}; index++) {
    vec4 geometry = u_blob_geometry[index];
    vec4 blobColor = u_blob_color[index];
    float verticalRadius = geometry.w * mix(
      u_lower_falloff,
      1.0,
      step(geometry.y, glowUv.y)
    );
    vec2 radius = vec2(geometry.z, verticalRadius);
    vec2 q = (glowUv - geometry.xy) / max(radius, vec2(0.0001));
    float weight = exp(-dot(q, q) * 2.15) * blobColor.a;
    colorSum += blobColor.rgb * weight;
    weightSum += weight;
  }

  // Translate the entire color field while the glass-cell geometry stays fixed.
  float movingAlpha = min(sampleEnvelope(glowUv), 0.96);
  float staticWallEnergy = min(sampleEnvelope(uv), 0.96);
  float wallEnergy = max(movingAlpha, staticWallEnergy * 0.24);
  vec3 mixedColor = colorSum / max(weightSum, 0.0001);
  return GradientSample(
    mixedColor * movingAlpha,
    movingAlpha,
    wallEnergy
  );
}

vec2 roundedBoxNormal(vec2 point, vec2 halfSize, float radius) {
  float epsilon = 0.8;
  float right = roundedBoxSdf(
    point + vec2(epsilon, 0.0),
    halfSize,
    radius
  );
  float left = roundedBoxSdf(
    point - vec2(epsilon, 0.0),
    halfSize,
    radius
  );
  float top = roundedBoxSdf(
    point + vec2(0.0, epsilon),
    halfSize,
    radius
  );
  float bottom = roundedBoxSdf(
    point - vec2(0.0, epsilon),
    halfSize,
    radius
  );
  vec2 gradient = vec2(right - left, top - bottom);
  return gradient * inversesqrt(max(dot(gradient, gradient), 0.0001));
}

float noise(vec2 point) {
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 fragment = gl_FragCoord.xy;
  vec2 uv = fragment / u_resolution;
  GradientSample background = sampleGradient(uv);
  float columnCount = 23.0;
  float targetCellSize = u_resolution.x / columnCount;
  float rowCount = max(1.0, round(u_resolution.y / targetCellSize));
  vec2 cellSize = u_resolution / vec2(columnCount, rowCount);
  float opticalCellSize = min(cellSize.x, cellSize.y);
  vec2 grid = fragment / cellSize;
  vec2 cellIndex = floor(grid);
  vec2 local = (fract(grid) - 0.5) * cellSize;
  vec2 halfSize = cellSize * 0.5;
  float radius = opticalCellSize * 0.145;
  float distanceToCell = roundedBoxSdf(local, halfSize, radius);
  float antialias = max(fwidth(distanceToCell), 0.65);
  float inside = 1.0 - smoothstep(
    -antialias * 0.35,
    antialias * 0.85,
    distanceToCell
  );

  float insetDepth = max(-distanceToCell, 0.0);
  float bevel = 1.0 - smoothstep(
    0.0,
    opticalCellSize * 0.035,
    insetDepth
  );
  vec2 edgeNormal = roundedBoxNormal(local, halfSize, radius);

  vec2 cellCenter = (cellIndex + 0.5) * cellSize;
  vec2 cellCenterUv = cellCenter / u_resolution;
  vec2 magnifiedUv = cellCenterUv + (uv - cellCenterUv) * 0.28;
  magnifiedUv -= edgeNormal * bevel * (vec2(0.5) / u_resolution);
  GradientSample refracted = sampleGradient(magnifiedUv);
  GradientSample centered = sampleGradient(cellCenterUv);
  vec2 frostStep = cellSize / u_resolution * 0.24;
  GradientSample frostLeft = sampleGradient(magnifiedUv - vec2(frostStep.x, 0.0));
  GradientSample frostRight = sampleGradient(magnifiedUv + vec2(frostStep.x, 0.0));
  GradientSample frostDown = sampleGradient(magnifiedUv - vec2(0.0, frostStep.y));
  GradientSample frostUp = sampleGradient(magnifiedUv + vec2(0.0, frostStep.y));

  vec3 diffusedPremul = (
    refracted.premul * 4.0 +
    frostLeft.premul +
    frostRight.premul +
    frostDown.premul +
    frostUp.premul
  ) / 8.0;
  float diffusedAlpha = (
    refracted.alpha * 4.0 +
    frostLeft.alpha +
    frostRight.alpha +
    frostDown.alpha +
    frostUp.alpha
  ) / 8.0;
  vec3 cellPremul = mix(diffusedPremul, centered.premul, 0.12);
  float cellAlpha = mix(diffusedAlpha, centered.alpha, 0.12);
  cellPremul = mix(cellPremul, u_cell * cellAlpha, 0.025);

  float wallStrength = mix(
    background.energy,
    centered.energy,
    0.65
  );
  float glassWallFade = smoothstep(0.0005, 0.035, wallStrength);
  float neutralGlassAlpha = glassWallFade * 0.008;
  cellPremul += u_cell * neutralGlassAlpha * (1.0 - cellAlpha);
  cellAlpha += neutralGlassAlpha * (1.0 - cellAlpha);

  float topLeftEdge = max(
    dot(edgeNormal, normalize(vec2(-0.72, 0.69))),
    0.0
  ) * bevel;
  float bottomRightEdge = max(
    dot(edgeNormal, normalize(vec2(0.72, -0.69))),
    0.0
  ) * bevel;

  float highlight = bevel * 0.012 + bottomRightEdge * 0.008;
  cellPremul = mix(
    cellPremul,
    vec3(cellAlpha),
    clamp(highlight, 0.0, 0.025)
  );
  float shadowAlpha = topLeftEdge * glassWallFade * 0.004;
  cellPremul *= 1.0 - shadowAlpha;
  cellAlpha += shadowAlpha * (1.0 - cellAlpha);
  float frostNoise = (noise(fragment) - 0.5) / 255.0;
  cellPremul += vec3(frostNoise) * cellAlpha * 0.55;

  float glassMix = inside * glassWallFade;
  vec3 premul = mix(
    background.premul,
    cellPremul,
    glassMix
  );
  float alpha = mix(background.alpha, cellAlpha, glassMix);
  vec3 straightColor = alpha > 0.0001
    ? premul / alpha
    : vec3(0.0);

  outColor = vec4(
    clamp(straightColor, 0.0, 1.0),
    clamp(alpha, 0.0, 0.96)
  );
}
`

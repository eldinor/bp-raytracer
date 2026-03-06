#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;

void main() {
  outColor = texture(uTex, vec2(vUv.x, 1.0 - vUv.y));
}

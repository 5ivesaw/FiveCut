struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSample(input_texture, input_sampler, input.tex_coord);
    let brightness = uniforms.scalars.x;
    let contrast = uniforms.scalars.y;
    let saturation = uniforms.scalars.z;
    let vignette = uniforms.scalars.w;
    let temperature = uniforms.direction.x;
    let tint = uniforms.direction.y;

    var rgb = source.rgb + vec3f(brightness);
    rgb = (rgb - vec3f(0.5)) * contrast + vec3f(0.5);
    let luminance = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3f(luminance), rgb, saturation);
    rgb = rgb + vec3f(temperature * 0.11, temperature * 0.025, -temperature * 0.11);
    rgb = rgb + vec3f(tint * 0.06, -tint * 0.05, tint * 0.06);

    let centered = input.tex_coord - vec2f(0.5);
    let aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
    let distance = length(vec2f(centered.x * aspect, centered.y));
    let edge = smoothstep(0.28, 0.78, distance);
    rgb = rgb * (1.0 - edge * vignette);
    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), source.a);
}

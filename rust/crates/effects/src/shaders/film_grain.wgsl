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

fn hash(position: vec2f) -> f32 {
    let value = dot(position, vec2f(12.9898, 78.233));
    return fract(sin(value) * 43758.5453);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSample(input_texture, input_sampler, input.tex_coord);
    let intensity = max(uniforms.scalars.x, 0.0);
    let grain_size = max(uniforms.scalars.y, 1.0);
    let grain_position = floor(input.tex_coord * uniforms.resolution / grain_size);
    let noise = (hash(grain_position) - 0.5) * intensity;
    return vec4f(clamp(source.rgb + vec3f(noise), vec3f(0.0), vec3f(1.0)), source.a);
}

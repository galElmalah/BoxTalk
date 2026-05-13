// Single source of truth for TTS models in the renderer.
// The backend (main.js) has its own minimal registry used for dispatch;
// this list is what the UI shows and persists references to.

export const MODELS = [
  {
    id: "kokoro",
    label: "Kokoro 82M",
    description: "hexgrad/Kokoro · q8 quantized ONNX · onnxruntime-node",
    sizeLabel: "~80 MB",
    speed: 9,
    fluency: 7,
    runModes: [],
    voices: [
      { id: "af_heart",    label: "Heart",    accent: "American female" },
      { id: "af_bella",    label: "Bella",    accent: "American female" },
      { id: "af_nicole",   label: "Nicole",   accent: "American female" },
      { id: "af_sarah",    label: "Sarah",    accent: "American female" },
      { id: "af_sky",      label: "Sky",      accent: "American female" },
      { id: "am_adam",     label: "Adam",     accent: "American male" },
      { id: "am_michael",  label: "Michael",  accent: "American male" },
      { id: "am_onyx",     label: "Onyx",     accent: "American male" },
      { id: "am_fenrir",   label: "Fenrir",   accent: "American male" },
      { id: "bf_emma",     label: "Emma",     accent: "British female" },
      { id: "bf_isabella", label: "Isabella", accent: "British female" },
      { id: "bm_george",   label: "George",   accent: "British male" },
      { id: "bm_lewis",    label: "Lewis",    accent: "British male" },
    ],
  },
  {
    id: "vibevoice-realtime",
    label: "VibeVoice Realtime 0.5B",
    description: "vibevoice.cpp · Q8_0 GGUF · pre-baked voices · low-latency streaming",
    sizeLabel: "~2 GB",
    speed: 8,
    fluency: 9,
    runModes: [
      { id: "single", label: "Single Speaker", default: true },
    ],
    voices: [
      { id: "vv05_carter", label: "Carter", accent: "English (male)" },
      { id: "vv05_emma",   label: "Emma",   accent: "English (female)" },
    ],
  },
  {
    id: "vibevoice-1.5b",
    label: "VibeVoice 1.5B",
    description: "Microsoft · up to 4 speakers · voice cloning from reference audio",
    sizeLabel: "~6 GB",
    speed: 5,
    fluency: 10,
    runModes: [
      { id: "single", label: "Single Speaker", default: true },
      { id: "multi",  label: "Multi-Speaker (Podcast)" },
    ],
    voices: [
      { id: "vv15_clone", label: "Reference clone", accent: "needs audio reference" },
    ],
  },
  {
    id: "vibevoice-large",
    label: "VibeVoice Large 7B",
    description: "Microsoft · highest fidelity · ModelScope mirror",
    sizeLabel: "~14 GB",
    speed: 3,
    fluency: 10,
    runModes: [
      { id: "single", label: "Single Speaker", default: true },
      { id: "multi",  label: "Multi-Speaker (Podcast)" },
    ],
    voices: [
      { id: "vv7_clone", label: "Reference clone", accent: "needs audio reference" },
    ],
  },
];

export function modelByVoiceId(voiceId) {
  return MODELS.find((m) => m.voices.some((v) => v.id === voiceId)) ?? null;
}

export function voiceById(voiceId) {
  for (const m of MODELS) {
    const v = m.voices.find((vv) => vv.id === voiceId);
    if (v) return v;
  }
  return null;
}

export function defaultVoiceId() {
  return MODELS[0].voices[0].id;
}

export function defaultRunMode(model) {
  return model.runModes.find((r) => r.default)?.id ?? null;
}

// One-off paid generation of the "first step" onboarding mockup images via Kie AI
// (same text model as production avatars). Resumable: a submitted task is polled, never resubmitted.
// Usage: KIE_API_KEY in .env.local, then node scripts/onboarding-avatars.mjs
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: [".env.local", ".env"], quiet: true });
const API = "https://api.kie.ai";
const key = process.env.KIE_API_KEY?.trim();
const model = "seedream/5-flash-text-to-image";
const output = path.resolve("docs/onboarding-first-step-2026-10-14");
const statePath = path.join(output, "generation.json");

const realism = "Natural skin texture, face softly lit and clearly readable at thumbnail size, anatomically correct hands. Centered composition, head fully inside the frame with room above. Vertical 3:4 portrait. No lettering, no watermark, no logo.";
const anime = "Original modern anime key visual, clean line art, controlled cel shading, vivid cinematic lighting, expressive face. Clearly an adult with mature facial proportions. Centered composition, head fully inside the frame with room above, face readable at thumbnail size. Vertical 3:4 portrait. No lettering, no watermark, no resemblance to existing franchise characters.";
const sceneAnime = "Original anime background art, clean line art, cel shading, rich cinematic lighting, no people in the foreground. Square composition. No lettering, no watermark.";
const sceneReal = "Cinematic photorealistic environment photograph, shallow depth of field, rich natural lighting, no people. Square composition. No lettering, no watermark.";
const portrait = (id, style, text) => ({ id, style, aspect: "3:4", prompt: `${text} Exactly one adult person. ${style === "anime" ? anime : realism}` });
const scenes = {
  romance: "a rain-soaked evening city street with warm cafe windows and a single red umbrella left open on a bench, soft rose and violet glow",
  fantasy: "a floating castle above the clouds at dusk with glowing magic runes, waterfalls falling into the sky and a violet aurora",
  adventure: "a narrow mountain path leading to ancient overgrown ruins at sunrise, a worn leather backpack and a map on a rock in the foreground",
  mystic: "a foggy gothic mansion at night under a huge pale moon, candlelight in one window, bare twisted trees",
  detective: "a dim noir detective office desk with case files, a magnifying glass and a desk lamp, rain streaking the window with neon reflections",
  scifi: "a neon cyberpunk megacity at night seen from a high balcony, flying cars, holographic billboards without readable text, a starship in the sky",
  everyday: "a cozy small apartment kitchen in the morning, two coffee mugs, plants on the windowsill, warm sunlight",
  drama: "an empty train platform at dusk with one lit lamp, a single suitcase and falling autumn leaves, melancholic mood",
  comedy: "a cheerful messy kitchen where a fluffy ginger cat has knocked over a bag of flour, flour clouds in the air, bright playful colors",
};
const cases = [
  { id: "cover-anime", style: "anime", aspect: "3:4", prompt: `Two adult characters, a man and a woman about 25 years old, standing side by side waist-up and looking at the viewer with confident friendly expressions. He has tousled silver hair and a dark coat, she has long black hair with a rose-pink streak and a violet jacket. Twilight city rooftop where floating paper lanterns and cherry blossom petals drift in the air, rich violet and rose color palette. Exactly two adults. ${anime}` },
  { id: "cover-realism", style: "realism", aspect: "3:4", prompt: `A cinematic photorealistic waist-up portrait of two adults, a man and a woman about 28 years old, standing close side by side and looking at the camera with calm confident expressions. He wears a dark charcoal coat, she wears a deep burgundy jacket. Evening city street behind them with soft violet and rose neon bokeh, shallow depth of field, 50mm film still look. Exactly two adult people. ${realism}` },
  portrait("anime-kairen", "anime", "Waist-up portrait of an adult male mage lecturer about 27 years old. Tousled silver-white hair, violet eyes, a dark navy high-collar academy coat with fine gold embroidery. A small glowing violet sigil floats above his open palm. Night gothic library with floating candles behind him. Calm, slightly teasing half-smile."),
  portrait("anime-mira", "anime", "Waist-up portrait of an adult female courier and hacker about 25 years old. Short asymmetrical black bob with one neon pink streak, cyan eyes, an oversized black techwear jacket with glowing magenta trim, a small holographic display projected above her wrist. Rainy neon cyberpunk street at night behind her. Confident playful smirk. Fully clothed, non-sexualized."),
  portrait("anime-yuki", "anime", "Waist-up portrait of an adult female barista about 24 years old. Long chestnut hair in a loose braid over one shoulder, warm amber eyes, cream knit sweater under a sage green apron. She holds a cup of latte with heart latte art in both hands. Sunlit cozy cafe with plants and warm morning light behind her. Gentle warm smile."),
  portrait("anime-ren", "anime", "Waist-up portrait of an adult male exorcist about 28 years old. Shoulder-length black hair tied back, crimson eyes, a long dark charcoal coat with paper talismans pinned to the lapel, holding a single glowing paper charm between two fingers. Misty mountain shrine at night with stone lanterns behind him. Serious, protective gaze."),
  portrait("anime-lina", "anime", "Waist-up portrait of an adult female elf ranger who looks about 26 years old. Long braided golden hair, emerald eyes, pointed ears, green-brown leather armor with leaf motifs, a coiled rope on her shoulder. Sky islands and waterfalls in bright daylight behind her. Bold adventurous grin."),
  portrait("real-artem", "realism", "A photorealistic waist-up character portrait of a 29-year-old male musician. Messy dark brown hair, grey-green eyes, light stubble, black leather jacket over a plain grey T-shirt, an acoustic guitar strap over his shoulder. City rooftop at golden hour with the skyline behind him. Reserved thoughtful look with a faint smile."),
  portrait("real-vera", "realism", "A photorealistic waist-up character portrait of a 32-year-old female private investigator. Sleek black hair in a low bun, dark brown eyes, camel trench coat over a black turtleneck. She holds an old brass key at chest level. Dim office with a rain-streaked window and a warm desk lamp behind her, film noir lighting. Intelligent, wary gaze."),
  portrait("real-daniel", "realism", "A photorealistic waist-up character portrait of a 30-year-old male wasteland scout. Short dark blond hair, blue eyes, a thin scar on his chin, weathered olive field jacket with patches, an old brass compass hanging from his neck. Overgrown ruins of an abandoned city at dusk behind him. Determined but warm expression."),
  portrait("real-alisa", "realism", "A photorealistic waist-up character portrait of a 27-year-old female illustrator. Curly copper-red hair, freckles, hazel eyes, an oversized denim shirt with small paint stains, holding a sketchbook and a pencil. Sunny apartment balcony with potted plants behind her. Laughing, playful expression."),
  portrait("real-mark", "realism", "A photorealistic waist-up character portrait of a 36-year-old male starship captain. Short black hair with grey temples, dark brown eyes, warm brown skin, navy flight jacket with embroidered mission patches without readable text. Spaceship bridge with a large window full of stars behind him. Calm, steady, slightly protective look."),
  ...Object.entries(scenes).flatMap(([id, text]) => [
    { id: `genre-${id}-anime`, style: "anime", aspect: "1:1", prompt: `${text}. ${sceneAnime}` },
    { id: `genre-${id}-realism`, style: "realism", aspect: "1:1", prompt: `${text}. ${sceneReal}` },
  ]),
];

async function request(route, body) {
  const response = await fetch(`${API}${route}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 200) { const error = new Error(`Kie ${route}: HTTP ${response.status} code ${data.code}`); error.httpStatus = response.status; error.definite = response.status < 500; throw error; }
  return data.data ?? {};
}
const save = state => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2)); fs.renameSync(`${statePath}.tmp`, statePath); };
async function finish(job, state) {
  const started = Date.parse(job.startedAt);
  while (true) {
    const task = await request(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(job.taskId)}`);
    if (task.state === "fail") { job.status = "failed"; job.error = { failCode: task.failCode }; break; }
    if (task.state === "success") {
      const url = JSON.parse(String(task.resultJson)).resultUrls?.[0];
      const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`Image download HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const sharp = (await import("sharp")).default;
      fs.mkdirSync(path.join(output, "images"), { recursive: true });
      await sharp(bytes).png().toFile(path.join(output, "images", `${job.id}.png`));
      await sharp(bytes).resize({ width: job.aspect === "1:1" ? 480 : 720, withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(output, "images", `${job.id}.webp`));
      job.status = "completed"; job.credits = task.creditsConsumed ?? null; job.seconds = Math.round((Date.now() - started) / 1000);
      break;
    }
    if (Date.now() - started > 15 * 60_000) { job.status = "pending_review"; break; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  save(state);
  console.log(JSON.stringify({ id: job.id, status: job.status, credits: job.credits, seconds: job.seconds }));
}
async function run(job, state) {
  if (["completed", "failed", "uncertain"].includes(job.status)) return;
  if (!job.taskId) {
    job.status = "submitting"; job.startedAt = new Date().toISOString(); save(state);
    try {
      const data = await request("/api/v1/jobs/createTask", { model, input: { prompt: job.prompt, aspect_ratio: job.aspect, size: "1K", output_format: "png", nsfw_checker: true } });
      if (!data.taskId) throw Object.assign(new Error("No taskId"), { definite: false });
      job.taskId = data.taskId; job.status = "pending"; save(state);
    } catch (error) {
      // A 5xx or a missing task id may still have created a paid task: never resubmit automatically.
      job.status = error.definite ? "failed" : "uncertain"; job.error = { message: error.message };
      save(state); console.log(JSON.stringify({ id: job.id, status: job.status, error: job.error })); return;
    }
  }
  await finish(job, state);
}

if (!key) throw new Error("KIE_API_KEY is not configured (.env.local)");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { startedAt: new Date().toISOString(), model, jobs: cases.map(c => ({ ...c, status: "queued" })) };
save(state);
const queue = [...state.jobs];
await Promise.all([0, 1, 2, 3].map(async () => { while (queue.length) await run(queue.shift(), state); }));
state.totalCredits = state.jobs.reduce((sum, job) => sum + (Number(job.credits) || 0), 0);
save(state);
console.log(JSON.stringify({ done: true, totalCredits: state.totalCredits }));

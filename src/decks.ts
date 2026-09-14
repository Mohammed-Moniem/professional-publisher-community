import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import sharp from "sharp";
import { Store, hash } from "./store.js";
import { Fault } from "./model.js";
const require = createRequire(import.meta.url);
const PptxGenJS = require("../../vendor/pptxgenjs/index.cjs");
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const theme = z.object({ background: color, foreground: color, accent: color });
const themes = {
  editorial: {
    background: "#F7F3E8",
    foreground: "#202B32",
    accent: "#B8432B",
  },
  technical: {
    background: "#102332",
    foreground: "#F1F7FA",
    accent: "#53DBBC",
  },
  minimal: { background: "#FFFFFF", foreground: "#161616", accent: "#2459BA" },
  bold: { background: "#351D5C", foreground: "#FFFFFF", accent: "#F7CD51" },
};
const element = z.object({
  kind: z.enum(["text", "rect", "image"]),
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
  text: z.string().max(2000).optional(),
  path: z.string().optional(),
  fontSize: z.number().min(20).max(120).default(36),
  color: color.optional(),
});
export const slideSchema = z.object({
  layout: z
    .enum([
      "cover",
      "explanation",
      "process",
      "comparison",
      "quote",
      "chart",
      "screenshot",
      "closing",
      "custom",
    ])
    .default("explanation"),
  title: z.string().min(1).max(180),
  body: z.string().max(2200).default(""),
  imagePath: z.string().optional(),
  source: z.string().max(2000).optional(),
  chart: z
    .array(
      z.object({
        label: z.string().max(60),
        value: z.number().finite().min(0),
      }),
    )
    .max(8)
    .optional(),
  elements: z.array(element).max(40).optional(),
});
export const deckSchema = z.object({
  title: z.string().min(1).max(200),
  identity: z.string().min(1),
  aspect: z.enum(["portrait", "square", "wide"]).default("portrait"),
  theme: z
    .enum(["editorial", "technical", "minimal", "bold"])
    .default("editorial"),
  brand: theme
    .extend({
      footer: z.string().max(100).default(""),
      logoPath: z.string().optional(),
    })
    .optional(),
  slides: z.array(slideSchema).min(1).max(30),
});
export type DeckInput = z.infer<typeof deckSchema>;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export class Decks {
  constructor(public store: Store) {}
  async create(input: DeckInput, parentId?: string) {
    const deck = deckSchema.parse(input);
    const parent = parentId
      ? await this.store.read<any>("decks", parentId)
      : null;
    if (parentId && !parent)
      throw new Fault("DECK_NOT_FOUND", "Deck not found.");
    if (parent && parent.identity !== deck.identity)
      throw new Fault(
        "IDENTITY_MISMATCH",
        "Deck revisions must retain the same identity.",
      );
    const id = randomUUID(),
      dir = join(this.store.root, "decks", id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let asset = 0;
    const snapshot = async (path: string) => {
      const out = join(dir, `asset-${asset++}.png`);
      try {
        const image = sharp(path, { limitInputPixels: 36_000_000 });
        await image.png().toFile(out);
        return out;
      } catch {
        throw new Fault(
          "INVALID_IMAGE",
          "Use a readable local image under 36 megapixels.",
        );
      }
    };
    for (const slide of deck.slides) {
      if (slide.imagePath) slide.imagePath = await snapshot(slide.imagePath);
      for (const obj of slide.elements || [])
        if (obj.kind === "image") {
          if (!obj.path)
            throw new Fault(
              "MISSING_IMAGE",
              "Image elements need a local path.",
            );
          obj.path = await snapshot(obj.path);
        }
    }
    if (deck.brand?.logoPath)
      deck.brand.logoPath = await snapshot(deck.brand.logoPath);
    const value = {
      ...deck,
      id,
      parentId,
      version: (parent?.version || 0) + 1,
      createdAt: Date.now(),
    };
    await this.store.write("decks", id, value);
    await writeFile(join(dir, "source.json"), JSON.stringify(value, null, 2), {
      mode: 0o600,
    });
    return value;
  }
  async revise(id: string, index: number, slide: z.infer<typeof slideSchema>) {
    const d = await this.store.read<any>("decks", id);
    if (!d) throw new Fault("DECK_NOT_FOUND", "Deck not found.");
    if (index < 1 || index > d.slides.length)
      throw new Fault("INVALID_SLIDE", "Use a 1-based existing slide number.");
    d.slides[index - 1] = slideSchema.parse(slide);
    return this.create(d, id);
  }
  async brand(identity: string, value: NonNullable<DeckInput["brand"]>) {
    const brand = deckSchema.shape.brand.unwrap().parse(value);
    if (brand.logoPath) {
      const dir = join(this.store.root, "media");
      await this.store.init();
      const path = join(dir, "brand-" + hash(identity) + ".png");
      await sharp(brand.logoPath, { limitInputPixels: 36_000_000 })
        .png()
        .toFile(path);
      brand.logoPath = path;
    }
    await this.store.write("brands", hash(identity), brand);
    return brand;
  }
  async render(id: string) {
    return this.store.lock("deck-" + id, async () => {
      const d = await this.store.read<any>("decks", id);
      if (!d) throw new Fault("DECK_NOT_FOUND", "Deck not found.");
      const width = d.aspect === "wide" ? 1600 : 1080,
        height =
          d.aspect === "portrait" ? 1350 : d.aspect === "wide" ? 900 : 1080;
      const palette = d.brand || themes[d.theme as keyof typeof themes];
      const dir = join(this.store.root, "decks", id);
      const data = async (path: string) =>
        "data:image/png;base64," + (await readFile(path)).toString("base64");
      const fontPath =
        require.resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2");
      const arabicPath =
        require.resolve("@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff2");
      const fonts = `@font-face{font-family:Noto;src:url(data:font/woff2;base64,${(await readFile(fontPath)).toString("base64")})}@font-face{font-family:NotoArabic;src:url(data:font/woff2;base64,${(await readFile(arabicPath)).toString("base64")})}`;
      const pptx = new PptxGenJS();
      pptx.defineLayout({
        name: "CAROUSEL",
        width: width / 120,
        height: height / 120,
      });
      pptx.layout = "CAROUSEL";
      pptx.author = "Professional Publisher Community";
      pptx.subject = d.title;
      pptx.title = d.title;
      pptx.lang = "en-US";
      const pages: string[] = [];
      for (let i = 0; i < d.slides.length; i++) {
        const s = d.slides[i],
          objects: any[] = [];
        const hasGraphic = !!s.imagePath || s.layout === "chart";
        const text=(value:string,x:number,y:number,w:number,h:number,size:number,color=palette.foreground)=>objects.push({kind:'text',x,y,width:w,height:h,text:value,fontSize:size,color});
        const rule=(y:number,w=width-144)=>objects.push({kind:'rect',x:72,y,width:w,height:3,color:palette.accent});
        if (!hasGraphic && (s.layout==='cover'||s.layout==='closing')) {
          text(s.layout==='cover'?'FIELD NOTES':'YOUR NEXT STEP',72,100,width-144,50,24,palette.accent);
          text(s.title,72,height*.24,width-144,height*.32,88);
          if(s.body)text(s.body,72,height*.64,width-144,height*.22,44);
          rule(height*.16,120);
        } else {
          text(s.title,72,100,width-144,230,68);
          rule(370);
          if(!hasGraphic && s.layout==='process') {
            const steps=s.body.split(/\n+/).filter((v:string)=>v.trim());
            if(steps.length>5)throw new Fault('TOO_MANY_STEPS','Use at most five steps, or split the process.');
            const row=(height-560)/Math.max(steps.length,1);
            steps.forEach((v:string,n:number)=>{text(String(n+1).padStart(2,'0'),72,440+n*row,100,row-20,42,palette.accent);text(v,210,440+n*row,width-282,row-20,44);});
          } else if(!hasGraphic && s.layout==='comparison') {
            const parts=s.body.split(/\n\s*\n/).filter((v:string)=>v.trim());
            const w=(width-200)/2;
            parts.slice(0,2).forEach((v:string,n:number)=>text(v,72+n*(w+56),450,w,height*.28,44));
            if(parts.length>2)text(parts.slice(2).join('\n\n'),72,height*.76,width-144,height*.13,34);
          } else if(s.body) {
            text(s.body,72,hasGraphic?410:480,width-144,hasGraphic?170:height-650,s.layout==='quote'?58:46);
          }
        }
        if (s.imagePath)
          objects.push({
            kind: "image",
            x: 72,
            y: 610,
            width: width - 144,
            height: Math.max(100, height - 780),
            path: s.imagePath,
          });
        if (s.chart?.length) {
          if (!s.source)
            throw new Fault(
              "CHART_SOURCE_REQUIRED",
              "Charts need a data source note.",
            );
          const max = Math.max(
            ...s.chart.map((r: any) => Math.abs(r.value)),
            1,
          );
          s.chart.forEach((r: any, n: number) => {
            const y = 620 + n * 70;
            objects.push(
              {
                kind: "text",
                x: 72,
                y,
                width: 280,
                height: 58,
                text: r.label,
                fontSize: 26,
                color: palette.foreground,
              },
              {
                kind: "rect",
                x: 360,
                y,
                width: Math.max(1, (Math.abs(r.value) / max) * (width - 550)),
                height: 40,
                color: palette.accent,
              },
              {
                kind: "text",
                x: width - 160,
                y,
                width: 100,
                height: 58,
                text: String(r.value),
                fontSize: 26,
                color: palette.foreground,
              },
            );
          });
        }
        if (s.layout === "custom" && s.elements) {
          objects.splice(
            0,
            objects.length,
            ...s.elements.map((e: any) => ({
              ...e,
              color: e.color || palette.foreground,
            })),
          );
        }
        if (d.brand?.logoPath)
          objects.push({
            kind: "image",
            x: width - 150,
            y: 25,
            width: 70,
            height: 50,
            path: d.brand.logoPath,
          });
        const slide = pptx.addSlide();
        slide.background = { color: palette.background.slice(1) };
        let html = "";
        for (const obj of objects) {
          if (obj.x + obj.width > width || obj.y + obj.height > height - 100)
            throw new Fault(
              "SLIDE_OVERFLOW",
              `Slide ${i + 1} has an object outside the safe area. Split content or adjust layout.`,
            );
          const style = `left:${obj.x}px;top:${obj.y}px;width:${obj.width}px;height:${obj.height}px;`;
          const coords = {
            x: obj.x / 120,
            y: obj.y / 120,
            w: obj.width / 120,
            h: obj.height / 120,
          };
          if (obj.kind === "text") {
            html += `<div class="object text" dir="auto" style="${style}font-size:${obj.fontSize}px;color:${obj.color}">${esc(obj.text || "")}</div>`;
            slide.addText(obj.text || "", {
              ...coords,
              fontSize: obj.fontSize * 0.6,
              fontFace: /[\u0600-\u06ff]/.test(obj.text || "")
                ? "Noto Sans Arabic"
                : "Noto Sans",
              color: obj.color.slice(1),
              breakLine: false,
              margin: 0,
              rtlMode: /[\u0600-\u06ff]/.test(obj.text || ""),
              valign: "top",
            });
          } else if (obj.kind === "rect") {
            html += `<div class="object" style="${style}background:${obj.color}"></div>`;
            slide.addShape(pptx.ShapeType.rect, {
              ...coords,
              fill: { color: obj.color.slice(1) },
              line: { color: obj.color.slice(1) },
            });
          } else {
            html += `<img class="object" style="${style}object-fit:contain" src="${await data(obj.path)}">`;
            slide.addImage({
              path: obj.path,
              ...pptx.imageSizingContain(
                obj.path,
                coords.x,
                coords.y,
                coords.w,
                coords.h,
              ),
            });
          }
        }
        const footer = `${d.brand?.footer ? d.brand.footer + " · " : ""}${i + 1}/${d.slides.length}`;
        html += `<footer>${esc(footer)}${s.source ? "<br>" + esc(s.source) : ""}</footer>`;
        slide.addText(footer + (s.source ? "\n" + s.source : ""), {
          x: 0.6,
          y: (height - 75) / 120,
          w: (width - 144) / 120,
          h: 0.4,
          fontSize: 12,
          color: palette.foreground.slice(1),
        });
        pages.push(
          `<section class="slide" style="background:${palette.background};color:${palette.foreground}">${html}</section>`,
        );
      }
      const html = `<!doctype html><meta charset="utf-8"><style>${fonts}*{box-sizing:border-box}body{margin:0}.slide{position:relative;width:${width}px;height:${height}px;page-break-after:always;overflow:hidden}.object{position:absolute}.text{font-family:Noto,NotoArabic,sans-serif;line-height:1.3;white-space:pre-wrap;overflow-wrap:anywhere}footer{position:absolute;left:72px;bottom:25px;max-width:${width - 144}px;height:52px;font:18px Noto,NotoArabic,sans-serif;overflow-wrap:anywhere}@page{size:${width}px ${height}px;margin:0}</style>${pages.join("")}`;
      await writeFile(join(dir, "deck.html"), html, { mode: 0o600 });
      let browser;
      try {
        browser = await chromium.launch({ headless: true });
      } catch {
        throw new Fault(
          "RENDERER_UNAVAILABLE",
          "Install the matching Chromium runtime using the documented renderer setup command.",
        );
      }
      const previews: string[] = [];
      try {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.route("**/*", (route) => route.abort());
        await page.setContent(html);
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.locator(".text,footer").evaluateAll((els) =>
          els
            .map((e, i) => ({
              i,
              overflow:
                e.scrollHeight > e.clientHeight + 2 ||
                e.scrollWidth > e.clientWidth + 2,
            }))
            .filter((r) => r.overflow),
        );
        if (overflow.length)
          throw new Fault(
            "TEXT_OVERFLOW",
            "Some slide text does not fit. Split the slide or shorten the text; do not silently shrink it.",
          );
        for (let n = 0; n < pages.length; n++) {
          const path = join(dir, `slide-${String(n + 1).padStart(2, "0")}.png`);
          await page.locator(".slide").nth(n).screenshot({ path });
          previews.push(path);
        }
        await page.pdf({
          path: join(dir, "deck.pdf"),
          printBackground: true,
          preferCSSPageSize: true,
        });
      } finally {
        await browser.close();
      }
      await pptx.writeFile({ fileName: join(dir, "deck.pptx") });
      const tw = 270,
        th = Math.round((height / width) * tw),
        cols = Math.min(4, previews.length);
      const tiles = await Promise.all(
        previews.map(async (p, n) => ({
          input: await sharp(p).resize(tw, th).png().toBuffer(),
          left: (n % cols) * tw,
          top: Math.floor(n / cols) * th,
        })),
      );
      await sharp({
        create: {
          width: cols * tw,
          height: Math.ceil(previews.length / cols) * th,
          channels: 4,
          background: "#ddd",
        },
      })
        .composite(tiles)
        .png()
        .toFile(join(dir, "contact-sheet.png"));
      const result = {
        deckId: id,
        pdf: join(dir, "deck.pdf"),
        pptx: join(dir, "deck.pptx"),
        source: join(dir, "source.json"),
        html: join(dir, "deck.html"),
        contactSheet: join(dir, "contact-sheet.png"),
        slides: previews,
        digest: hash(await readFile(join(dir, "deck.pdf"))),
        reviewRequired:
          "Inspect every PNG for visual clarity before preparing the PDF post. PowerPoint text/shapes are editable; application font rendering can differ.",
      };
      await this.store.write("deck_exports", id, result);
      return result;
    });
  }
}

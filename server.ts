import index from "./index.html";
import { collect } from "./state";

const PORT = Number(process.env.HUBERT_PORT ?? 7777);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/api/state": () => Response.json(collect()),
    "/api/lazygit": {
      POST: async (req) => {
        const { root } = (await req.json()) as { root?: string };
        // only open repos we are currently reporting, never arbitrary paths
        if (!root || !collect().repos.some((r) => r.root === root)) return new Response("unknown repo", { status: 400 });
        Bun.spawn(["kitty", "--class", "hubert-lazygit", "--directory", root, "lazygit"], { stdio: ["ignore", "ignore", "ignore"] }).unref();
        return new Response("ok");
      },
    },
  },
});

console.log(`hubert on ${server.url}`);

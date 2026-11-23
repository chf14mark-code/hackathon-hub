import { createFileRoute } from "@tanstack/react-router";
// @ts-expect-error JS module
import App from "../sim/App.jsx";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CPU Simulator Enhanced" },
      { name: "description", content: "Step through assembly programs and watch registers, cache and memory in action." },
      { property: "og:title", content: "CPU Simulator Enhanced" },
      { property: "og:description", content: "Step through assembly programs and watch registers, cache and memory in action." },
    ],
  }),
  component: App,
});

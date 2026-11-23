import { createFileRoute } from "@tanstack/react-router";
// @ts-expect-error JS module
import Guide from "../sim/Guide.jsx";

export const Route = createFileRoute("/guide")({
  head: () => ({
    meta: [
      { title: "Assembly Guide — CPU Simulator" },
      { name: "description", content: "Learn the simulator's instructions: MOV, LOAD, STORE, ADD, SUB and JNZ." },
      { property: "og:title", content: "Assembly Guide — CPU Simulator" },
      { property: "og:description", content: "Learn the simulator's instructions: MOV, LOAD, STORE, ADD, SUB and JNZ." },
    ],
  }),
  component: Guide,
});

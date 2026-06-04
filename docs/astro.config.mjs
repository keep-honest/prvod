import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import remarkGfm from "remark-gfm";

// https://astro.build/config
export default defineConfig({
  site: "https://docs.prvod.dev",
  markdown: {
    remarkPlugins: [remarkGfm],
  },
  integrations: [
    starlight({
      title: "PRVOD docs",
      description:
        "Quick start and concept docs for PRVOD — an open-source tool that generates video walkthroughs for pull requests and codebases.",
      logo: {
        src: "./src/assets/wordmark.svg",
        replacesTitle: false,
      },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/keep-honest/prvod",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/keep-honest/prvod/edit/main/docs/",
      },
      sidebar: [
        {
          label: "Get started",
          items: [
            // Root index page — Starlight has no slug shortcut for it, so a
            // link entry is the supported form. All other entries use slug
            // so a missing/renamed page fails the build instead of silently
            // rendering a dead link.
            { label: "Welcome", link: "/" },
            { label: "Quick start", slug: "quickstart" },
          ],
        },
        {
          label: "Understand",
          items: [
            { label: "Concepts", slug: "concepts" },
            { label: "How PRVOD compares", slug: "compare" },
          ],
        },
        {
          label: "Reference",
          items: [{ label: "FAQ", slug: "faq" }],
        },
      ],
    }),
  ],
});

import { test, expect, describe, afterEach } from "bun:test";
import { fetchPostsFromWordPress } from "./wordpress";
import type { PostSource } from "./types";

const source: PostSource = {
  type: "wordpress",
  apiUrl: "https://example.com/wp-json/wp/v2",
  category: "campinas",
  dateRange: { start: "2026-06-27", end: "2026-07-11" },
};

const originalFetch = globalThis.fetch;

function mockFetch(routes: (url: string) => Response | Promise<Response>): void {
  const fake = (input: string | URL | Request): Promise<Response> =>
    Promise.resolve(routes(String(input)));
  globalThis.fetch = fake as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchPostsFromWordPress", () => {
  test("resolves category slug and maps posts to {url, date}", async () => {
    mockFetch((url) => {
      if (url.includes("/categories")) {
        return new Response(JSON.stringify([{ id: 10, slug: "campinas" }]));
      }
      return new Response(
        JSON.stringify([
          { id: 1, date: "2026-07-01T10:00:00", link: "https://example.com/post-1/" },
          { id: 2, date: "2026-07-01T08:00:00", link: "https://example.com/post-2/" },
          { id: 3, date: "2026-06-28T12:00:00", link: "https://example.com/post-3/" },
        ]),
        { headers: { "x-wp-total": "3", "x-wp-totalpages": "1" } },
      );
    });

    const posts = await fetchPostsFromWordPress(source);

    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual({ url: "https://example.com/post-3/", date: "2026-06-28" });
    expect(posts[1]).toEqual({ url: "https://example.com/post-1/", date: "2026-07-01" });
  });

  test("keeps newest post of each day", async () => {
    mockFetch((url) => {
      if (url.includes("/categories")) {
        return new Response(JSON.stringify([{ id: 10 }]));
      }
      return new Response(
        JSON.stringify([
          { id: 1, date: "2026-07-01T10:00:00", link: "https://example.com/newest/" },
          { id: 2, date: "2026-07-01T08:00:00", link: "https://example.com/older/" },
        ]),
        { headers: { "x-wp-totalpages": "1" } },
      );
    });

    const posts = await fetchPostsFromWordPress(source);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://example.com/newest/");
  });

  test("paginates using x-wp-totalpages header", async () => {
    const requestedPages: number[] = [];
    mockFetch((url) => {
      if (url.includes("/categories")) {
        return new Response(JSON.stringify([{ id: 10 }]));
      }
      const page = parseInt(new URL(url).searchParams.get("page")!, 10);
      requestedPages.push(page);
      if (page === 1) {
        return new Response(
          JSON.stringify([{ id: 1, date: "2026-07-01T10:00:00", link: "https://example.com/a/" }]),
          { headers: { "x-wp-total": "2", "x-wp-totalpages": "2" } },
        );
      }
      return new Response(
        JSON.stringify([{ id: 2, date: "2026-07-02T10:00:00", link: "https://example.com/b/" }]),
        { headers: { "x-wp-total": "2", "x-wp-totalpages": "2" } },
      );
    });

    const posts = await fetchPostsFromWordPress(source);
    expect(requestedPages).toEqual([1, 2]);
    expect(posts).toHaveLength(2);
  });

  test("applies after/before date filters", async () => {
    let postsUrl = "";
    mockFetch((url) => {
      if (url.includes("/categories")) {
        return new Response(JSON.stringify([{ id: 10 }]));
      }
      postsUrl = url;
      return new Response("[]", { headers: { "x-wp-totalpages": "1" } });
    });

    await fetchPostsFromWordPress(source);
    const params = new URL(postsUrl).searchParams;
    expect(params.get("after")).toBe("2026-06-27T00:00:00");
    expect(params.get("before")).toBe("2026-07-11T23:59:59");
    expect(params.get("categories")).toBe("10");
    expect(params.get("order")).toBe("desc");
  });

  test("throws when category slug is not found", async () => {
    mockFetch(() => new Response("[]"));
    expect(fetchPostsFromWordPress(source)).rejects.toThrow(/not found/);
  });

  test("supports multiple category slugs", async () => {
    const seen = new Set<string>();
    mockFetch((url) => {
      if (url.includes("/categories")) {
        const slug = new URL(url).searchParams.get("slug");
        return new Response(JSON.stringify([{ id: slug === "campinas" ? 10 : 20 }]));
      }
      seen.add(new URL(url).searchParams.get("categories")!);
      return new Response("[]", { headers: { "x-wp-totalpages": "1" } });
    });

    await fetchPostsFromWordPress({ ...source, category: ["campinas", "cultura-campinas"] });
    expect([...seen].sort()).toEqual(["10", "20"]);
  });
});

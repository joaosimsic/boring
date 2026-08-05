import type { Post, PostSource } from "./types";

interface WpPost {
  id: number;
  date: string;
  link: string;
}

async function resolveCategoryId(apiUrl: string, slug: string): Promise<number> {
  const url = `${apiUrl}/categories?slug=${encodeURIComponent(slug)}&_fields=id`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`WordPress API error (${res.status}) resolving category "${slug}"`);
  }
  const cats = (await res.json()) as { id: number }[];
  if (cats.length === 0) {
    throw new Error(`Category "${slug}" not found on WordPress site`);
  }
  return cats[0]!.id;
}

async function fetchCategoryPosts(
  apiUrl: string,
  categoryId: number,
  after: string,
  before: string,
  perPage: number,
): Promise<WpPost[]> {
  const posts: WpPost[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url =
      `${apiUrl}/posts?categories=${categoryId}` +
      `&after=${encodeURIComponent(after)}` +
      `&before=${encodeURIComponent(before)}` +
      `&per_page=${perPage}&page=${page}` +
      `&_fields=id,date,link&orderby=date&order=desc`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`WordPress API error (${res.status}) fetching posts page ${page}`);
    }
    const rawTotalPages = res.headers.get("x-wp-totalpages");
    if (rawTotalPages) {
      totalPages = parseInt(rawTotalPages, 10);
    }
    posts.push(...((await res.json()) as WpPost[]));
    page++;
  } while (page <= totalPages);

  return posts;
}

function onePostPerDay(posts: Post[]): Post[] {
  const byDay = new Map<string, Post>();
  for (const post of posts) {
    const day = post.date;
    if (!byDay.has(day)) {
      byDay.set(day, post);
    }
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function fetchPostsFromWordPress(source: PostSource): Promise<Post[]> {
  const apiUrl = source.apiUrl.replace(/\/+$/, "");
  const perPage = source.perPage ?? 100;
  const after = `${source.dateRange.start}T00:00:00`;
  const before = `${source.dateRange.end}T23:59:59`;

  const categories = Array.isArray(source.category) ? source.category : [source.category];
  const all: WpPost[] = [];
  for (const slug of categories) {
    const id = await resolveCategoryId(apiUrl, slug);
    const posts = await fetchCategoryPosts(apiUrl, id, after, before, perPage);
    all.push(...posts);
  }

  const posts = all.map((p) => ({ url: p.link, date: p.date.slice(0, 10) }));
  return onePostPerDay(posts);
}

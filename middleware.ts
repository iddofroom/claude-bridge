import { NextResponse, type NextRequest } from "next/server";
import { verifySessionCookie, ADMIN_COOKIE } from "@/lib/admin-auth";

export const config = {
  // Only run middleware on routes that need a guard. Public-API routes,
  // bridge webhook, cron, the login page, and Next.js assets fall through
  // and authenticate themselves (or are intentionally public).
  matcher: ["/admin/:path*"],
};

export async function middleware(req: NextRequest) {
  const cookie = req.cookies.get(ADMIN_COOKIE)?.value;
  if (await verifySessionCookie(cookie)) return NextResponse.next();

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

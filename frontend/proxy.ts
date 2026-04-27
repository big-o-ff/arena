import { clerkMiddleware } from '@clerk/nextjs/server'

// Only run Clerk on routes that require login. Public pages (/, /spectate, /sign-in, …)
// skip middleware entirely so the Edge runtime never blocks on Clerk API calls.
export default clerkMiddleware(async (auth, request) => {
  await auth.protect({
    unauthenticatedUrl: new URL('/sign-in', request.url).toString(),
  })
})

export const config = {
  matcher: [
    '/lobby(.*)',
    '/battle(.*)',
    '/admin(.*)',
    '/profile(.*)',
  ],
}

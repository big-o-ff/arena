import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Define which routes don't require login
const isPublicRoute = createRouteMatcher([
  '/',
  '/spectate(.*)',
  '/api/webhooks(.*)',
  '/sign-in(.*)', // Ensure the sign-in page itself is public!
  '/sign-up(.*)',
])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    // Force redirect to your custom centered route
    await auth.protect({
      unauthenticatedUrl: new URL('/sign-in', request.url).toString(),
    });
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
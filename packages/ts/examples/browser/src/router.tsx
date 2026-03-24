import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

function NotFound() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 text-center">
      <h1 className="mb-2 font-serif text-3xl tracking-tight">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        The page you're looking for doesn't exist. Head back to the Datasets tab to get started.
      </p>
    </div>
  )
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: NotFound,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}

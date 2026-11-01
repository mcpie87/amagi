import { RouterProvider } from '@tanstack/react-router'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { apiBase } from './api.ts'
import { installInteractionTracking } from './interactions.ts'
import { router } from './routes.tsx'
import { DashboardProvider } from './store.tsx'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

installInteractionTracking(() => router.state.matches.at(-1)?.routeId ?? location.pathname)

function AuthenticatedDashboard() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  useEffect(() => {
    const check = () => {
      void fetch(`${apiBase}/api/auth-status`, { cache: 'no-store' })
        .then((res) => res.json())
        .then((body: { authenticated?: boolean }) => setAuthenticated(body.authenticated === true))
        .catch(() => setAuthenticated(false))
    }
    check()
    const timer = setInterval(check, 5000)
    return () => clearInterval(timer)
  }, [])
  if (authenticated === null) return null
  if (!authenticated)
    return <main className="p-8">Open the login link printed by amagi serve.</main>
  return (
    <DashboardProvider>
      <RouterProvider router={router} />
    </DashboardProvider>
  )
}

createRoot(root).render(
  <StrictMode>
    <AuthenticatedDashboard />
  </StrictMode>,
)

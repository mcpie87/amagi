import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { router } from './routes.tsx'
import { DashboardProvider } from './store.tsx'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <DashboardProvider>
      <RouterProvider router={router} />
    </DashboardProvider>
  </StrictMode>,
)

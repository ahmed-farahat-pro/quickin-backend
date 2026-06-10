import type { ReactNode } from 'react'

export const metadata = {
  title: 'QuickIn API',
  description: 'Standalone backend API for QuickIn — listings, bookings, and auth.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  )
}

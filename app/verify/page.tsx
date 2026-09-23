import type { Metadata } from "next"

import { VerifyView } from "@/components/verify/verify-view"

export const metadata: Metadata = { title: "验证隐性水印 · Veilmark" }

export default function Page() {
  return <VerifyView />
}

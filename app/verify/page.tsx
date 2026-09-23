import type { Metadata } from "next"

import { VerifyView } from "@/components/verify/verify-view"

export const metadata: Metadata = { title: "验证水印与版权证书 · Veilmark" }

export default function Page() {
  return <VerifyView />
}

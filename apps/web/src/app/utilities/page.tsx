import type { Metadata } from "next";

import { Utilities } from "@/components/utilities/Utilities";

export const metadata: Metadata = {
  title: "Convert, compress & resize",
  description: "Convert between JPEG, PNG, WebP and BMP, compress and resize one or many images in your browser. Nothing is uploaded.",
};

export default function UtilitiesPage() {
  return <Utilities />;
}

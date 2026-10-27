import type { Metadata } from "next";

import { Utilities } from "@/components/utilities/Utilities";

export const metadata: Metadata = {
  title: "Convert, compress & resize",
  description: "Convert, compress, resize and clean one or many images on your computer. Nothing is uploaded.",
};

export default function UtilitiesPage() {
  return <Utilities />;
}

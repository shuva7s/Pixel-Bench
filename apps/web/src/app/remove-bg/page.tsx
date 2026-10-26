import type { Metadata } from "next";

import { RemoveBackground } from "@/components/remove-bg/RemoveBackground";

export const metadata: Metadata = {
  title: "Remove background",
  description: "Remove the background from a photo with an AI model that runs in your browser. Nothing is uploaded.",
};

export default function RemoveBackgroundPage() {
  return <RemoveBackground />;
}

import type { Metadata } from "next";

import { Editor } from "@/components/editor/Editor";

export const metadata: Metadata = {
  title: "Photo editor",
  description: "Lightroom-style photo editing: light, colour, colour mixer, effects, crop and straighten. Nothing is uploaded.",
};

export default function EditPage() {
  return <Editor />;
}

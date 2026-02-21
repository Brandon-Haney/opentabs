import React from "react";
import { allDocs } from "contentlayer/generated";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import MDX from "@/components/MDX";
import { Metadata } from "next";
import { generateToc } from "@/lib/toc";
import TableOfContents from "@/components/TableOfContents";

interface IProps {
  params: { slug: string[] };
}

function getDocParams({ params }: IProps) {
  const slug = `/docs${params.slug ? `/${params.slug.join("/")}` : ""}`;
  const doc = allDocs.find((doc) => doc.url === slug);

  if (!doc) {
    return null;
  }

  return doc;
}

export async function generateMetadata({ params }: IProps): Promise<Metadata> {
  const doc = getDocParams({ params });

  if (!doc) {
    return {
      title: "Not Found | OpenTabs",
    };
  }

  return {
    title: `${doc.title} | OpenTabs`,
    description: doc.description,
  };
}

export default async function page({ params }: IProps) {
  const doc = getDocParams({ params });

  if (!doc) {
    return notFound();
  }

  const toc = await generateToc(doc.body.raw);
  return (
    <>
      {/* Main Content */}
      <div className="flex-1 space-y-12 py-12 px-4 max-w-2xl mx-auto w-full">
        <div>
          <MDX code={doc.body.code} />
        </div>
        <p className="text-right">
          Last Updated: {format(doc.lastUpdated, "dd MMM, yyy")}
        </p>
      </div>

      {/* Table of Contents */}
      <div className="hidden lg:block lg:w-60 flex-shrink-0 sticky top-36 self-start space-y-6">
        <TableOfContents toc={toc} />
      </div>
    </>
  );
}

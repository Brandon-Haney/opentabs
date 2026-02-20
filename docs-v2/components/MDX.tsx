"use client";

import { Alert, Badge, Card, Text } from "@/components/retroui";
import { useMDXComponent } from "next-contentlayer/hooks";
import React, { AnchorHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import Link from "next/link";
import { CliCommand } from "./ComponentInstall";
import Image from "next/image";
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from "@headlessui/react";
import { Table } from "./retroui/Table";

const components = {
  h1: (props: HTMLAttributes<HTMLHeadingElement>) => (
    <Text as="h1" {...props} />
  ),
  h2: (props: HTMLAttributes<HTMLHeadingElement>) => (
    <Text as="h2" className="border-b pb-1 mb-6" {...props} />
  ),
  h3: (props: HTMLAttributes<HTMLHeadingElement>) => (
    <Text as="h3" className="mb-4" {...props} />
  ),
  h4: (props: HTMLAttributes<HTMLHeadingElement>) => (
    <Text as="h4" className="mb-2" {...props} />
  ),
  h5: (props: HTMLAttributes<HTMLHeadElement>) => <Text as="h5" {...props} />,
  h6: (props: HTMLAttributes<HTMLHeadElement>) => <Text as="h6" {...props} />,
  p: (props: HTMLAttributes<HTMLHeadElement>) => <Text {...props} />,
  li: (props: HTMLAttributes<HTMLHeadElement>) => (
    <Text as="li" className="mb-2" {...props} />
  ),
  img: ({ src, alt = "" }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <Image
      src={src ?? ""}
      alt={alt}
      width={600}
      height={400}
      className="mx-auto w-full max-w-[600px] my-8"
      unoptimized
    />
  ),
  a: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const { href, target, rel, ...rest } = props;

    if (!href) {
      return <a {...rest} />;
    }

    const isExternal = href.startsWith("http");

    return isExternal ? (
      <a
        href={href}
        target={target || "_blank"}
        rel={rel || "noopener noreferrer"}
        className="underline underline-offset-4 hover:decoration-primary"
        {...rest}
      />
    ) : (
      <Link
        href={href}
        className="underline underline-offset-4 hover:decoration-primary"
        {...rest}
      />
    );
  },
  pre: CodeBlock,
  code: ({
    className,
    children,
    ...props
  }: React.HTMLAttributes<HTMLElement>) => (
    <code
      className={cn(
        "relative rounded-sm bg-[#282A36] p-1 text-primary text-sm",
        className,
      )}
      {...props}
    >
      {children}
    </code>
  ),
  TabGroup,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
  Table,
  Link,
  Badge,
  Image,
  Card,
  Alert,
  CliCommand,
};

export default function MDX({ code }: { code: string }) {
  const Content = useMDXComponent(code);

  return <Content components={components} />;
}

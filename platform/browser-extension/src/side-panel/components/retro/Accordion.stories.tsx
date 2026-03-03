import * as AccordionPrimitive from '@radix-ui/react-accordion';
import type { Meta, StoryObj } from '@storybook/react';
import { ChevronDown } from 'lucide-react';
import { Accordion } from './Accordion';

const meta: Meta = {
  title: 'Retro/Accordion',
  decorators: [Story => <div className="w-80">{Story()}</div>],
};

type Story = StoryObj;

const Single: Story = {
  render: () => (
    <Accordion type="single" collapsible className="space-y-2">
      <Accordion.Item value="a">
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger className="flex flex-1 cursor-pointer items-start justify-between px-3 py-2 font-head focus:outline-hidden [&[data-state=open]>svg]:rotate-180">
            Section A
            <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
        <Accordion.Content className="p-3">Content A</Accordion.Content>
      </Accordion.Item>
      <Accordion.Item value="b">
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger className="flex flex-1 cursor-pointer items-start justify-between px-3 py-2 font-head focus:outline-hidden [&[data-state=open]>svg]:rotate-180">
            Section B
            <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
        <Accordion.Content className="p-3">Content B</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  ),
};

const Multiple: Story = {
  render: () => (
    <Accordion type="multiple" defaultValue={['a']} className="space-y-2">
      <Accordion.Item value="a">
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger className="flex flex-1 cursor-pointer items-start justify-between px-3 py-2 font-head focus:outline-hidden [&[data-state=open]>svg]:rotate-180">
            Open by default
            <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
        <Accordion.Content className="p-3">This starts open.</Accordion.Content>
      </Accordion.Item>
      <Accordion.Item value="b">
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger className="flex flex-1 cursor-pointer items-start justify-between px-3 py-2 font-head focus:outline-hidden [&[data-state=open]>svg]:rotate-180">
            Collapsed
            <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
        <Accordion.Content className="p-3">Click to expand.</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  ),
};

export default meta;
export { Single, Multiple };

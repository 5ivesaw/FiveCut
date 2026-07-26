import type { Metadata } from "next";
import { BasePage } from "@/app/base-page";
import { GitHubContributeSection } from "@/components/gitHub-contribute-section";
import { Badge } from "@/components/ui/badge";
import { ReactMarkdownWrapper } from "@/components/ui/react-markdown-wrapper";
import { cn } from "@/utils/ui";

const LAST_UPDATED = "July 26, 2026";

type StatusType = "complete" | "pending" | "default" | "info";

interface Status {
	text: string;
	type: StatusType;
}

interface RoadmapItem {
	title: string;
	description: string;
	status: Status;
}

const roadmapItems: RoadmapItem[] = [
	{
		title: "Editor foundation",
		description:
			"Timeline editing, local project storage, effects, captions, keyframes, masks, audio mixing, and export are available.",
		status: {
			text: "Completed",
			type: "complete",
		},
	},
	{
		title: "Linux desktop release",
		description:
			"A portable offline-capable Linux x64 desktop build is published automatically through GitHub Releases.",
		status: {
			text: "Completed",
			type: "complete",
		},
	},
	{
		title: "Reliable creator workflows",
		description:
			"Continue improving performance, advanced trimming, export formats, proxy workflows, accessibility, and production-level regression coverage.",
		status: {
			text: "In progress",
			type: "pending",
		},
	},
	{
		title: "More desktop platforms",
		description:
			"Add signed Windows and macOS packages after platform-specific build and smoke-test pipelines are ready.",
		status: {
			text: "Planned",
			type: "default",
		},
	},
];

export const metadata: Metadata = {
	title: "Roadmap - FiveCut",
	description:
		"See what's coming next for FiveCut - the free, open-source video editor that respects your privacy.",
	openGraph: {
		title: "FiveCut Roadmap - What's Coming Next",
		description:
			"See what's coming next for FiveCut - the free, open-source video editor that respects your privacy.",
		type: "website",
		images: [
			{
				url: "/open-graph/roadmap.jpg",
				width: 1200,
				height: 630,
				alt: "FiveCut Roadmap",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "FiveCut Roadmap - What's Coming Next",
		description:
			"See what's coming next for FiveCut - the free, open-source video editor that respects your privacy.",
		images: ["/open-graph/roadmap.jpg"],
	},
};

export default function RoadmapPage() {
	return (
		<BasePage
			title="Roadmap"
			description={`What's coming next for FiveCut (last updated: ${LAST_UPDATED})`}
		>
			<div className="mx-auto flex max-w-4xl flex-col gap-16">
				<div className="flex flex-col gap-6">
					{roadmapItems.map((item, index) => (
						<RoadmapItem key={item.title} item={item} index={index} />
					))}
				</div>
				<GitHubContributeSection
					title="Want to help?"
					description="FiveCut is open source and built by the community. Every contribution,
          no matter how small, helps us build the best free video editor
          possible."
				/>
			</div>
		</BasePage>
	);
}

function RoadmapItem({ item, index }: { item: RoadmapItem; index: number }) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-medium">
				<span className="leading-normal select-none">{index + 1}</span>
				<h3>{item.title}</h3>
				<StatusBadge status={item.status} className="ml-1" />
			</div>
			<div className="text-foreground/70 leading-relaxed">
				<ReactMarkdownWrapper>{item.description}</ReactMarkdownWrapper>
			</div>
		</div>
	);
}

function StatusBadge({
	status,
	className,
}: {
	status: Status;
	className?: string;
}) {
	return (
		<Badge
			className={cn("shadow-none", className, {
				"bg-green-500! text-white": status.type === "complete",
				"bg-yellow-500! text-white": status.type === "pending",
				"bg-blue-500! text-white": status.type === "info",
				"bg-foreground/10! text-accent-foreground": status.type === "default",
			})}
		>
			{status.text}
		</Badge>
	);
}

export type Sponsor = {
	name: string;
	url: string;
	logo: string;
	description: string;
	invertOnDark?: boolean;
};

export const SPONSORS: Sponsor[] = [
	{
		name: "OpenCut",
		url: "https://github.com/OpenCut-app/OpenCut",
		logo: "/logos/opencut/icon.svg",
		description:
			"The open-source editor FiveCut was forked from and continues to credit.",
		invertOnDark: true,
	},
];

"use client";

import { MagicWand05Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "next/navigation";
import { type ChangeEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEditor } from "@/hooks/use-editor";
import { FiveCutImportError } from "@/lib/agent/import-project";

const directoryInputProps = {
	webkitdirectory: "",
	directory: "",
} as Record<"webkitdirectory" | "directory", string>;

function isJsonFile(file: File): boolean {
	return (
		file.type === "application/json" ||
		file.name.toLowerCase().endsWith(".json")
	);
}

function isMediaFile(file: File): boolean {
	return (
		file.type.startsWith("video/") ||
		file.type.startsWith("audio/") ||
		file.type.startsWith("image/")
	);
}

export function ImportAiProjectDialog() {
	const editor = useEditor();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [projectFile, setProjectFile] = useState<File | null>(null);
	const [mediaFiles, setMediaFiles] = useState<File[]>([]);
	const [isImporting, setIsImporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [errorDetails, setErrorDetails] = useState<string[]>([]);

	const selectedSummary = useMemo(() => {
		if (!projectFile && mediaFiles.length === 0) return "Nothing selected";
		const project = projectFile ? projectFile.name : "no JSON";
		const media = `${mediaFiles.length} media ${mediaFiles.length === 1 ? "file" : "files"}`;
		return `${project} · ${media}`;
	}, [mediaFiles.length, projectFile]);

	const clearError = () => {
		setError(null);
		setErrorDetails([]);
	};

	const handleOpenChange = (nextOpen: boolean) => {
		if (isImporting) return;
		setOpen(nextOpen);
		if (!nextOpen) clearError();
	};

	const handleFolder = (event: ChangeEvent<HTMLInputElement>) => {
		clearError();
		const files = Array.from(event.currentTarget.files ?? []);
		const jsonFiles = files.filter(isJsonFile);
		if (jsonFiles.length > 1) {
			setError("The selected folder contains more than one JSON file.");
			setErrorDetails(
				jsonFiles.map((file) => {
					const relativePath = (file as File & { webkitRelativePath?: string })
						.webkitRelativePath;
					return relativePath || file.name;
				}),
			);
			return;
		}
		setProjectFile(jsonFiles[0] ?? null);
		setMediaFiles(files.filter(isMediaFile));
	};

	const handleImport = async () => {
		clearError();
		if (!projectFile) {
			setError("Select the FiveCut project JSON first.");
			return;
		}

		setIsImporting(true);
		try {
			const rawDocument: unknown = JSON.parse(await projectFile.text());
			const result = await editor.project.importFiveCutProject({
				rawDocument,
				files: mediaFiles,
			});
			toast.success("AI edit imported", {
				description:
					result.warnings.length > 0
						? `${result.warnings.length} non-blocking warning(s)`
						: "Every referenced asset was validated.",
			});
			setOpen(false);
			router.push(`/editor/${result.projectId}`);
		} catch (caught) {
			if (caught instanceof FiveCutImportError) {
				setError(caught.message);
				setErrorDetails(caught.details);
			} else if (caught instanceof SyntaxError) {
				setError("The selected project file is not valid JSON.");
				setErrorDetails([caught.message]);
			} else {
				setError(
					caught instanceof Error ? caught.message : "The import failed.",
				);
			}
		} finally {
			setIsImporting(false);
		}
	};

	return (
		<>
			<Button
				variant="outline"
				size="lg"
				className="hidden gap-2 sm:flex"
				onClick={() => setOpen(true)}
			>
				<HugeiconsIcon icon={MagicWand05Icon} className="size-4" />
				Import AI edit
			</Button>
			<Button
				variant="outline"
				size="icon"
				className="sm:hidden"
				aria-label="Import AI edit"
				onClick={() => setOpen(true)}
			>
				<HugeiconsIcon icon={MagicWand05Icon} className="size-4" />
			</Button>

			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
					<DialogHeader>
						<DialogTitle>Import an AI edit</DialogTitle>
						<DialogDescription>
							Select a FiveCut project JSON plus the original media it
							references. Paths and optional SHA-256 hashes are checked before
							anything is saved.
						</DialogDescription>
					</DialogHeader>

					<DialogBody>
						<div className="grid gap-2">
							<Label htmlFor="fivecut-ai-project">Project JSON</Label>
							<Input
								id="fivecut-ai-project"
								type="file"
								accept="application/json,.json"
								disabled={isImporting}
								onChange={(event) => {
									clearError();
									setProjectFile(event.currentTarget.files?.[0] ?? null);
								}}
							/>
						</div>

						<div className="grid gap-2">
							<Label htmlFor="fivecut-ai-media">Referenced media</Label>
							<Input
								id="fivecut-ai-media"
								type="file"
								accept="video/*,audio/*,image/*"
								multiple
								disabled={isImporting}
								onChange={(event) => {
									clearError();
									setMediaFiles(Array.from(event.currentTarget.files ?? []));
								}}
							/>
						</div>

						<div className="grid gap-2">
							<Label htmlFor="fivecut-ai-folder">Or select one folder</Label>
							<Input
								{...directoryInputProps}
								id="fivecut-ai-folder"
								type="file"
								disabled={isImporting}
								onChange={handleFolder}
							/>
							<p className="text-muted-foreground text-xs">
								The folder option discovers one JSON file and all supported
								media below it.
							</p>
						</div>

						<div className="bg-muted/40 rounded-md border px-3 py-2 text-sm">
							{selectedSummary}
						</div>

						{error ? (
							<div
								className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
								role="alert"
							>
								<p className="font-medium">{error}</p>
								{errorDetails.length > 0 ? (
									<ul className="mt-2 max-h-28 list-disc space-y-1 overflow-auto pl-5 text-xs">
										{errorDetails.slice(0, 20).map((detail) => (
											<li key={detail}>{detail}</li>
										))}
									</ul>
								) : null}
							</div>
						) : null}
					</DialogBody>

					<DialogFooter>
						<Button
							variant="outline"
							disabled={isImporting}
							onClick={() => handleOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							disabled={!projectFile || isImporting}
							onClick={handleImport}
						>
							{isImporting ? "Validating and importing…" : "Import project"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

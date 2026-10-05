// Bun's bundler resolves image imports to their served URL.
declare module '*.webp' {
	const url: string;
	export default url;
}

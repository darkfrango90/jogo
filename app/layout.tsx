import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title:"Hangman Arena — Forca Multiplayer", description:"Jogue forca online em tempo real com até quatro amigos.", manifest:"/manifest.webmanifest", applicationName:"Hangman Arena", appleWebApp:{capable:true,statusBarStyle:"black-translucent",title:"Hangman Arena"}, icons:{icon:"/icon.svg",apple:"/icon.svg"} };
export const viewport: Viewport = { width:"device-width", initialScale:1, themeColor:"#080912" };
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="pt-BR"><body>{children}</body></html>}

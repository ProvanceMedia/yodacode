// YodaCode ASCII banner — pre-rendered, no figlet dependency.

const BANNER = `
██╗   ██╗ ██████╗ ██████╗  █████╗  ██████╗ ██████╗ ██████╗ ███████╗
╚██╗ ██╔╝██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ╚████╔╝ ██║   ██║██║  ██║███████║██║     ██║   ██║██║  ██║█████╗
  ╚██╔╝  ██║   ██║██║  ██║██╔══██║██║     ██║   ██║██║  ██║██╔══╝
   ██║   ╚██████╔╝██████╔╝██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗
   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
`;

const ORANGE = '\x1b[38;5;208m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export function printBanner() {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  if (color) {
    process.stdout.write(ORANGE + BANNER + RESET + '\n');
    process.stdout.write(DIM + '   Personal Claude-Code-powered chat agent for Slack, WhatsApp & beyond.\n\n' + RESET);
  } else {
    process.stdout.write(BANNER + '\n');
    process.stdout.write('   Personal Claude-Code-powered chat agent for Slack, WhatsApp & beyond.\n\n');
  }
}

const config = require('./config');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
    console.log("Launching browser...");
    const page = await config.connect({ headless: false });
    try {
        console.log("Navigating to season 3091880...");
        await page.goto('https://st-cdn001.akamaized.net/bet9javirtuals/en/1/season/3091880', { waitUntil: 'networkidle2' });
        await delay(5000);

        console.log("Clicking Head to Head tab...");
        const h2hHandle = await page.evaluateHandle(() => {
            const els = Array.from(document.querySelectorAll('a, div, span, button'));
            return els.find(e => e.textContent.trim() === 'Head to Head' && e.offsetParent !== null && e.textContent.trim().length < 20);
        });

        if (h2hHandle && h2hHandle.asElement()) {
            await h2hHandle.asElement().click();
            await delay(4000);

            // Let's select "Borussia Dortmund" on the Left and "FC Bayern München" on the Right
            const targetLeftTeam = "Borussia Dortmund";
            const targetRightTeam = "FC Bayern München";

            console.log(`Selecting Left Team: ${targetLeftTeam}`);
            const leftSuccess = await page.evaluate((teamName) => {
                // Find all teambox elements (there are two on the page!)
                const teamboxes = Array.from(document.querySelectorAll('#teambox'));
                if (teamboxes.length < 2) return { success: false, reason: "Less than 2 teamboxes found" };

                // Left teambox is index 0
                const leftClickable = teamboxes[0].querySelector('.cursor-pointer');
                if (!leftClickable) return { success: false, reason: "Left clickable not found" };

                // Click left dropdown
                leftClickable.click();
                return { success: true };
            }, targetLeftTeam);

            console.log("Left dropdown click status:", leftSuccess);
            await delay(2000);

            // Now click the option in the dropdown list
            const leftOptionClicked = await page.evaluate((teamName) => {
                const options = Array.from(document.querySelectorAll('a, span')).filter(el => {
                    const text = el.textContent.trim();
                    return el.offsetParent !== null && text === teamName;
                });

                if (options.length > 0) {
                    options[0].click();
                    return { success: true };
                }
                return { success: false, reason: `Option not found for ${teamName}` };
            }, targetLeftTeam);

            console.log("Left option click status:", leftOptionClicked);
            await delay(3000);

            console.log(`Selecting Right Team: ${targetRightTeam}`);
            const rightSuccess = await page.evaluate((teamName) => {
                const teamboxes = Array.from(document.querySelectorAll('#teambox'));
                if (teamboxes.length < 2) return { success: false, reason: "Less than 2 teamboxes found" };

                // Right teambox is index 1
                const rightClickable = teamboxes[1].querySelector('.cursor-pointer');
                if (!rightClickable) return { success: false, reason: "Right clickable not found" };

                rightClickable.click();
                return { success: true };
            }, targetRightTeam);

            console.log("Right dropdown click status:", rightSuccess);
            await delay(2000);

            const rightOptionClicked = await page.evaluate((teamName) => {
                const options = Array.from(document.querySelectorAll('a, span')).filter(el => {
                    const text = el.textContent.trim();
                    return el.offsetParent !== null && text === teamName;
                });

                if (options.length > 0) {
                    options[0].click();
                    return { success: true };
                }
                return { success: false, reason: `Option not found for ${teamName}` };
            }, targetRightTeam);

            console.log("Right option click status:", rightOptionClicked);
            await delay(4000);

            // Verify currently selected teams on screen
            const currentTeams = await page.evaluate(() => {
                const teamboxes = Array.from(document.querySelectorAll('#teambox'));
                return teamboxes.map(t => {
                    const names = Array.from(t.querySelectorAll('.sr-h2h-teambox-teamname')).map(e => e.textContent.trim());
                    return names.sort((a,b)=>b.length-a.length)[0] || '';
                });
            });

            console.log("Currently selected teams displayed:", currentTeams);

        } else {
            console.log("Head to Head tab not found!");
        }

    } catch (e) {
        console.error("Error:", e);
    } finally {
        console.log("Done");
    }
}

run();

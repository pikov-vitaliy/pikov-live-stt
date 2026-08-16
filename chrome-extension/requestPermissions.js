// Modified in 2026 by Vitaly Pikov for Pikov LiveSTT; based on WhisperLiveKit.
/**
 * Obtains the microphone grant for this extension's origin.
 *
 * The capture itself runs in an offscreen document, which can call
 * getUserMedia but cannot show the permission prompt — it has no UI surface.
 * This page exists purely to put that prompt in front of the user once; the
 * grant then applies to the whole extension origin.
 */

const stateElement = document.getElementById("state");
const requestButton = document.getElementById("request");

function say(text) {
    stateElement.textContent = text;
}

async function alreadyGranted() {
    try {
        const status = await navigator.permissions?.query?.({ name: "microphone" });
        return status?.state === "granted";
    } catch {
        return false;
    }
}

async function requestMicrophone() {
    requestButton.disabled = true;
    say("Ожидаю вашего ответа в окне браузера…");

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // The grant is what we came for; holding the device open would keep the
        // recording indicator lit for no reason.
        stream.getTracks().forEach((track) => track.stop());

        say("Доступ разрешён. Вкладку можно закрыть.");
        setTimeout(() => window.close(), 1200);
    } catch (error) {
        requestButton.disabled = false;
        const denied = error?.name === "NotAllowedError";
        say(denied
            ? "Доступ отклонён. Без него ваши реплики в стенограмму не попадут — нажмите кнопку ещё раз, если передумали."
            : `Не удалось получить доступ: ${error?.message || error}`);
    }
}

requestButton.addEventListener("click", () => { void requestMicrophone(); });

void (async () => {
    if (await alreadyGranted()) {
        say("Доступ уже был разрешён ранее. Вкладку можно закрыть.");
        setTimeout(() => window.close(), 1200);
        return;
    }
    // Chrome shows the prompt without a click here because the page was opened
    // by an explicit user action in the panel; the button is the fallback.
    void requestMicrophone();
})();

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { setupScene } from './setup.js';
import { UIManager } from './ui.js';
import { Game } from './game.js';
import { ReplayRecorder } from './replay.js';
import { CanvasUI } from './canvas-ui.js';
import { AudioManager } from './audio.js';

// Global state
let game, ui, canvasUI, audioManager;
let scene, world, camera, renderer, uiScene, uiCamera, sky;
let skyScene, skyCamera;
let pendingSubmissions = []; // Track background submissions

const room = new WebsimSocket();

async function fetchAllScores(collection, lastCreatedAt = null, fetchedScores = []) {
    // The Websim API returns records sorted newest to oldest.
    // By fetching records older than the last one we received, we can paginate through all of them.
    let query = collection;
    if (lastCreatedAt) {
        query = query.filter({ older_than_created_at: lastCreatedAt });
    }

    const newScores = await query.get(); // Using .get() for a one-time fetch

    if (newScores.length === 0) {
        return fetchedScores;
    }

    const combinedScores = fetchedScores.concat(newScores);
    const oldestRecord = newScores[newScores.length - 1];
    
    // The default limit is 1000, if we receive less, we're at the end.
    if (newScores.length < 1000) {
        return combinedScores;
    }

    return fetchAllScores(collection, oldestRecord.created_at, combinedScores);
}

function init() {
    const {
        scene: s,
        world: w,
        camera: c,
        renderer: r,
        defaultMaterial: dm,
        uiScene: us,
        uiCamera: uc,
        sky: skyInstance,
        skyScene: ss,
        skyCamera: sc
    } = setupScene();
    scene = s;
    world = w;
    camera = c;
    renderer = r;
    uiScene = us;
    uiCamera = uc;
    sky = skyInstance;
    skyScene = ss;
    skyCamera = sc;

    ui = new UIManager();
    canvasUI = new CanvasUI(uiScene);
    audioManager = new AudioManager();
    audioManager.loadSound('place', 'block_place.mp3');
    audioManager.loadSound('fail', 'fail_sound.mp3');

    const gameCallbacks = {
        onScoreUpdate: (score) => {
            ui.updateScore(score);
            canvasUI.updateScore(score);
        },
        onStreakUpdate: (count, isGolden, isPerfectHit) => {
            ui.updateStreak(count, isGolden, isPerfectHit);
        },
        onGameOver: (score) => {
            const endedGameSession = {
                score,
                replayRecorder: game.getReplayRecorder(),
            };
            
            // Stop the recorder immediately to finalize the video
            endedGameSession.replayRecorder?.stop();

            ui.showGameOver(score);
            ui.setReplayButtonState(true, 'Preparing...');
            
            handleFinishedGame(endedGameSession);
        }
    };

    game = new Game(scene, world, dm, camera, gameCallbacks, audioManager);
    
    setupEventListeners();
    
    // Subscribe to all scores for the public leaderboard and fetch all historical scores
    const scoreCollection = room.collection('score_v1');

    const updateLeaderboardUI = (scores) => {
        const sortedScores = scores.sort((a, b) => b.score - a.score);
        ui.updateLeaderboard(sortedScores, (replayUrl) => {
            ui.showReplayViewer(replayUrl);
        });
    };
    
    // Initial fetch of all scores
    fetchAllScores(scoreCollection).then(allScores => {
        updateLeaderboardUI(allScores);
        
        // After the initial load, subscribe to new scores to keep the leaderboard live
        scoreCollection.subscribe(liveScores => {
            // A simple merge strategy: use the live list if it's not empty, 
            // assuming it contains the most recent data including our own new scores.
            // For a more robust solution, we'd merge liveScores with allScores.
            const currentScores = liveScores.length > 0 ? liveScores : allScores;
            updateLeaderboardUI(currentScores);
        });
    }).catch(error => {
        console.error("Failed to fetch all scores:", error);
        // Fallback to subscribe if fetchAll fails
        scoreCollection.subscribe(scores => {
            updateLeaderboardUI(scores);
        });
    });


    renderer.setAnimationLoop(animate);
    startGame();
}

function startGame() {
    const newReplayRecorder = new ReplayRecorder(renderer.domElement, audioManager);
    game.start(newReplayRecorder);
    ui.hideGameOver();
    ui.showInstructions(true);
    canvasUI.updateScore(0);
}

function restart() {
    game.restart();
    startGame();
}

async function handleFinishedGame(session) {
    const { score, replayRecorder } = session;
    if (!replayRecorder) {
        autoSubmitScore(null, score, false);
        return;
    }

    const replayBlobPromise = replayRecorder.getReplayBlob();

    replayBlobPromise.then(blob => {
        ui.setReplayButtonState(false, 'Watch Replay', blob);
        autoSubmitScore(blob, score, true);
    }).catch(error => {
        console.error("Error getting replay blob:", error);
        ui.setReplayButtonState(false, 'Replay Failed');
        autoSubmitScore(null, score, false);
    });
}


async function autoSubmitScore(replayBlob, scoreToSubmit, hasReplay) {
    if (hasReplay && (!replayBlob || replayBlob.size === 0)) {
        console.warn("Auto-submit cancelled: replay blob is invalid.");
        if (!ui.gameOverElement.classList.contains('hidden')) {
            ui.setSubmitStatus('Replay failed. Score not submitted.', '#f44336');
        }
        return;
    }

    // Add visual indicator to trophy button
    const leaderboardButton = document.getElementById('leaderboard-button');
    leaderboardButton.classList.add('uploading');
    leaderboardButton.textContent = '⏳';

    const submissionPromise = (async () => {
        let isScoreSubmitted = false;
        try {
            const currentUser = await window.websim.getCurrentUser();
            if (!currentUser) {
                throw new Error('Could not get user info for submission.');
            }

            const allScores = room.collection('score_v1').getList();
            const userScores = allScores.filter(score => score.username === currentUser.username);
            userScores.sort((a, b) => a.score - b.score);

            let shouldSubmit = false;
            let lowestScoreRecord = null;

            if (userScores.length < 3) {
                shouldSubmit = true;
            } else {
                lowestScoreRecord = userScores[0];
                if (scoreToSubmit > lowestScoreRecord.score) {
                    shouldSubmit = true;
                }
            }

            if (!shouldSubmit) {
                console.log('Score too low for leaderboard.');
                if (!ui.gameOverElement.classList.contains('hidden')) {
                    ui.setSubmitStatus('Score is too low for the leaderboard.', '#ff9800');
                }
                return; 
            }
            
            let replayUrl = null;
            if (hasReplay && replayBlob) {
                try {
                    replayUrl = await window.websim.upload(replayBlob);
                    if (!replayUrl) throw new Error('Upload returned invalid URL');
                    
                    const response = await fetch(replayUrl, { method: 'HEAD' });
                    if (!response.ok) throw new Error('Uploaded file not accessible');

                } catch (uploadError) {
                    console.error("Replay upload failed:", uploadError);
                     if (!ui.gameOverElement.classList.contains('hidden')) {
                        ui.setSubmitStatus('Replay upload failed. Score not submitted.', '#f44336');
                    }
                    return; 
                }
            }

            if (hasReplay && !replayUrl) {
                console.error('Replay upload seems to have failed silently.');
                if (!ui.gameOverElement.classList.contains('hidden')) {
                    ui.setSubmitStatus('Replay upload incomplete. Score not submitted.', '#f44336');
                }
                return;
            }

            if (!ui.gameOverElement.classList.contains('hidden')) {
                 ui.setSubmitStatus('Saving to leaderboard...', '#ff9800');
            }

            const scoreData = { score: scoreToSubmit };
            if (replayUrl) {
                scoreData.replayUrl = replayUrl;
            }

            if (lowestScoreRecord && userScores.length >= 3) {
                await room.collection('score_v1').update(lowestScoreRecord.id, scoreData);
                if (!ui.gameOverElement.classList.contains('hidden')) {
                    ui.setSubmitStatus('High score updated!', '#4CAF50');
                }
            } else {
                await room.collection('score_v1').create(scoreData);
                if (!ui.gameOverElement.classList.contains('hidden')) {
                    ui.setSubmitStatus('Score submitted!', '#4CAF50');
                }
            }
            isScoreSubmitted = true;

        } catch (error) {
            console.error("Failed to auto-submit score:", error);
            if (!ui.gameOverElement.classList.contains('hidden')) {
                ui.setSubmitStatus('Error submitting score.', '#f44336');
            }
        } finally {
            if (isScoreSubmitted) {
                leaderboardButton.classList.remove('uploading');
                leaderboardButton.classList.add('upload-complete');
                leaderboardButton.textContent = '✅';
                
                setTimeout(() => {
                    leaderboardButton.classList.remove('upload-complete');
                    leaderboardButton.textContent = '🏆';
                }, 3000);
            } else {
                 leaderboardButton.classList.remove('uploading');
                 leaderboardButton.textContent = '🏆';
            }
        }
    })();

    pendingSubmissions.push(submissionPromise);
    submissionPromise.finally(() => {
        const index = pendingSubmissions.indexOf(submissionPromise);
        if (index > -1) {
            pendingSubmissions.splice(index, 1);
        }
    });
}

async function viewReplay() {
    const blob = ui.getCurrentReplayBlob();
    if (!blob) {
        alert("Replay not available or still processing.");
        return;
    }

    ui.setReplayButtonState(true, 'Loading...');
    try {
        ui.showReplayViewer(blob);
    } catch (error) {
        console.error("Error viewing replay:", error);
        alert("Could not load replay.");
    } finally {
        ui.setReplayButtonState(false, 'Watch Replay', blob);
    }
}

async function submitScore() {
    // This function is no longer used and can be removed or left empty.
    // For safety, we'll just log that it was called.
    console.log("submitScore called, but functionality is now in autoSubmitScore.");
}

function setupEventListeners() {
    ui.setupEventListeners({
        onPointerDown: () => {
            audioManager.unlockAudio();
            if (game.getState() === 'playing') {
                ui.showInstructions(false);
                game.onPointerDown();
            }
        },
        onRestart: restart,
        onViewReplay: viewReplay,
        onViewLeaderboard: () => ui.showLeaderboard(),
        onCloseLeaderboard: () => {
            ui.hideLeaderboard();
            const gameState = game.getState();
            if (gameState === 'gameover') {
                ui.showGameOver(game.getScore());
            } else if (gameState !== 'playing') {
                restart();
            }
            // If game is 'playing', do nothing extra, just hide the leaderboard.
        },
        onWindowResize: () => {
            const aspect = window.innerWidth / window.innerHeight;
            const frustumSize = 4;
            camera.left = frustumSize * aspect / -2;
            camera.right = frustumSize * aspect / 2;
            camera.top = frustumSize / 2;
            camera.bottom = frustumSize / -2;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);

            uiCamera.left = -window.innerWidth / 2;
            uiCamera.right = window.innerWidth / 2;
            uiCamera.top = window.innerHeight / 2;
            uiCamera.bottom = -window.innerHeight / 2;
            uiCamera.updateProjectionMatrix();
            canvasUI.onWindowResize();
        }
    });

    window.addEventListener('beforeunload', (event) => {
        if (pendingSubmissions.length > 0) {
            event.preventDefault();
            event.returnValue = ''; // For Chrome
            return "Your score is still uploading. Are you sure you want to leave?"; // For older browsers
        }
    });
}

function animate() {
    world.step(1 / 60);
    game.update();
    sky.update();
    
    renderer.clear();

    // Render sky first with its own camera
    renderer.render(skyScene, skyCamera);

    // Render game scene
    renderer.render(scene, camera);

    renderer.clearDepth();
    renderer.render(uiScene, uiCamera);
}

init();
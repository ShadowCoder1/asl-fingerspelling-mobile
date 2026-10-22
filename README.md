# Fingerspelling practice on your phone (research prototype)

Live: https://shadowcoder1.github.io/asl-fingerspelling-mobile/

The phone version of the fingerspelling practice demo: open the link on a phone (or a laptop), allow the camera, and
make each letter with your hand. A glove (or the letter's outline) is drawn in the camera view for your hand to fit
into, with your own hand's skeleton inside it; it turns green when the handshape is right, a ring fills while you hold
still, and after a miss it says which letter your hand looked like and what to change. Hand tracking is Google's
MediaPipe; the grader is a small statistical model fitted on public, openly licensed hand-landmark datasets
(attributions inside `tutor/model.json`). Everything runs on the device and nothing is recorded or saved.

This teaches fingerspelling handshapes, not ASL. To learn ASL, learn from Deaf teachers. Grading is approximate and
can be wrong.

Options: `?letters=LXG` (letters, in that order; letters without a glove get an outline), `&look=outline` (no gloves),
`&hand=left`, `&reps=2` (times through), `&fps=1` (frame rate on the camera view).

This folder is a published copy of the running page only.

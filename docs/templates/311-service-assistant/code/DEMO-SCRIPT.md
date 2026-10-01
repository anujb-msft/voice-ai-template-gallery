# 311 Service Assistant demo script

## 1. Open the console

Start the server in simulation mode:

```bash
npm start
```

Open <http://127.0.0.1:8096>. Point out the demo label, live transcript, case board, and metrics.

## 2. Emergency guard

Start a simulated call and type:

> I smell gas near my house

Expected: the assistant interrupts with the gas emergency redirect, logs `emergency_redirect`, and creates no case.

## 3. FAQ grounding

Start a new call and type:

> When is trash pickup on Maple Street?

Expected: the answer cites the Sanitation service guide. Ask about old hours to show expired content is not used.

## 4. Service request and priority transfer

Type:

> There is a large pothole in the travel lane at Oak and 5th

Expected: Oak Avenue at 5th Street is confirmed, required fields are filled, a case number is read in groups twice, and because it is a priority hazard in business hours the demo simulates a Public Works transfer with `CallTopic` and `CallContext`.

## 5. Duplicate

Start another call and repeat the same pothole report. Expected: the existing case is reused and the case board me-too count increases.

## 6. Status privacy

Type:

> What's the status of SR-26-0193?

Expected: only status and department are spoken. No reporter name or callback number is revealed.

## 7. Guided service

Type:

> I need bulk pickup for a mattress at 1200 Maple Street

Expected: the item is eligible, the next Zone A date is selected, and a case number is issued. Try “paint” to show the ineligible-item guard.

## 8. Person, DTMF, and repeat

Use **DTMF 0** to transfer to the 311 live-agent queue. Use **Repeat*** to repeat the last phrase.

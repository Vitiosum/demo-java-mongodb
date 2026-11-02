package cloud.clever.observatory;

import static org.hamcrest.Matchers.containsString;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest({HealthController.class, SkyController.class})
class HealthControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private MongoTemplate mongo;

    @Test
    void healthAnswersWithoutTouchingMongoDb() throws Exception {
        mvc.perform(get("/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ok"))
                .andExpect(header().exists("Content-Security-Policy"));
        verifyNoInteractions(mongo);
    }

    @Test
    void deepHealthReportsADatabaseOutage() throws Exception {
        when(mongo.getDb()).thenThrow(new IllegalStateException("no database"));
        mvc.perform(get("/health/deep"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.status").value("down"));
    }

    @Test
    void anUnknownQueryIsA400WithHelp() throws Exception {
        mvc.perform(get("/api/query").param("q", "drop everything"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value(containsString("has moons")));
        verifyNoInteractions(mongo);
    }
}
